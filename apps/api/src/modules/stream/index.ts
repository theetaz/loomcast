import { LIVE_STREAM_PATH } from "@loomcast/contracts";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { createLiveHub, type StreamEntry } from "./hub";

export {
  type Attachment,
  createLiveHub,
  encodeFrame,
  type LiveHub,
  type LiveHubOptions,
  STREAM_BUFFER_SIZE,
  type StreamClient,
  type StreamEntry,
} from "./hub";

/** A comment line keeps idle connections open through proxies and lets clients notice drops. */
export const STREAM_HEARTBEAT_MS = 15_000;

/**
 * A stream ends after this long and the browser reconnects (with `Last-Event-ID`, so nothing is
 * lost). Reconnecting re-checks the session, so a signed-out or disabled account stops receiving
 * events within this time.
 */
export const STREAM_MAX_AGE_MS = 30 * 60_000;

/**
 * A client that falls this far behind is disconnected rather than buffered without bound; it
 * reconnects and is replayed or told to resync.
 */
export const STREAM_MAX_PENDING = 1000;

/** How long the browser waits before reconnecting a dropped stream. */
export const STREAM_RETRY_MS = 3_000;

const HEARTBEAT_FRAME = ": heartbeat\n\n";

/**
 * `GET /api/stream`: live events as server-sent events. The default-deny guard has already
 * required a session. Each event's `data` is one JSON `LiveEvent`, without an `event:` name, so
 * `EventSource.onmessage` receives everything.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const hub = createLiveHub(deps.bus);
  deps.lifecycle.onClose(() => hub.close());
  const router = new Hono<AppEnv>();

  router.get(LIVE_STREAM_PATH, (c) => {
    const user = currentUser(c);
    const log = c.get("logger");
    const lastEventId = c.req.header("last-event-id");
    // Tell nginx not to buffer the stream.
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let ended = false;
      let wake: (() => void) | null = null;

      const signal = () => {
        const resolve = wake;
        wake = null;
        resolve?.();
      };
      const end = () => {
        ended = true;
        signal();
      };
      const push = (frame: string) => {
        if (queue.length >= STREAM_MAX_PENDING) {
          log.warn({ userId: user.id }, "live stream client fell behind; disconnecting");
          end();
          return;
        }
        queue.push(frame);
        signal();
      };

      const attachment = hub.attach(lastEventId, {
        deliver: (entry: StreamEntry) => push(entry.frame),
        close: end,
      });
      stream.onAbort(end);
      const heartbeat = setInterval(() => push(HEARTBEAT_FRAME), STREAM_HEARTBEAT_MS);
      const maxAge = setTimeout(end, STREAM_MAX_AGE_MS);
      heartbeat.unref();
      maxAge.unref();
      log.debug(
        { userId: user.id, clients: hub.clientCount, resync: attachment.resync },
        "live stream opened",
      );

      queue.unshift(`retry: ${STREAM_RETRY_MS}\n\n`, ...attachment.backlog.map((e) => e.frame));
      try {
        while (!ended) {
          const frame = queue.shift();
          if (frame === undefined) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          await stream.write(frame);
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(maxAge);
        attachment.detach();
        log.debug({ userId: user.id, clients: hub.clientCount }, "live stream closed");
      }
    });
  });

  app.route("/", router);
  return router;
}
