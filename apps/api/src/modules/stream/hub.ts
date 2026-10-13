import { randomBytes } from "node:crypto";
import type { LiveEvent } from "@loomcast/contracts";
import type { EventBus, Unsubscribe } from "../../lib/bus";

/** Events kept for `Last-Event-ID` replay. */
export const STREAM_BUFFER_SIZE = 1000;

/** One event as sent to every client: its SSE id and the encoded frame. */
export interface StreamEntry {
  seq: number;
  id: string;
  frame: string;
}

export interface StreamClient {
  /** Receives every live event published after the client attached. */
  deliver(entry: StreamEntry): void;
  /** The hub is closing; end the stream. */
  close(): void;
}

export interface Attachment {
  /** What the client sends first: replayed events, or a single `resync`. */
  backlog: StreamEntry[];
  /** True when the client could not be replayed and was sent `resync`. */
  resync: boolean;
  detach(): void;
}

/**
 * Numbers every live event on the bus and fans it out to the connected `/api/stream` clients. The
 * last `bufferSize` events stay in memory, so a client that reconnects with `Last-Event-ID`
 * receives what it missed.
 *
 * Event ids are `<epoch>-<seq>`: `seq` counts up from 1 in this process and `epoch` is random per
 * process, so an id from before a restart (or from another instance) is recognised as unknown
 * and answered with `resync` rather than a replay of unrelated events.
 */
export interface LiveHub {
  readonly epoch: string;
  /** Sequence number of the newest event; 0 before the first. */
  readonly head: number;
  readonly clientCount: number;
  /**
   * Registers a client and returns its backlog. Both happen synchronously, so no event published
   * in between is lost or delivered twice.
   */
  attach(lastEventId: string | undefined, client: StreamClient): Attachment;
  /** Unsubscribes from the bus and closes every client. */
  close(): void;
}

export interface LiveHubOptions {
  bufferSize?: number;
  epoch?: string;
}

const ID_RE = /^([a-z0-9]+)-(\d{1,15})$/;

export function encodeFrame(id: string, event: LiveEvent): string {
  // JSON.stringify never emits a raw line break, so the event fits one `data:` line.
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createLiveHub(bus: EventBus, options: LiveHubOptions = {}): LiveHub {
  const bufferSize = options.bufferSize ?? STREAM_BUFFER_SIZE;
  const epoch = options.epoch ?? randomBytes(4).toString("hex");
  const buffer: StreamEntry[] = [];
  const clients = new Set<StreamClient>();
  let head = 0;
  let unsubscribe: Unsubscribe | null = null;

  const idOf = (seq: number) => `${epoch}-${seq}`;

  unsubscribe = bus.subscribeLive((event) => {
    head += 1;
    const id = idOf(head);
    const entry: StreamEntry = { seq: head, id, frame: encodeFrame(id, event) };
    buffer.push(entry);
    if (buffer.length > bufferSize) {
      buffer.shift();
    }
    for (const client of [...clients]) {
      client.deliver(entry);
    }
  });

  /** The events after `lastEventId`, or null when they cannot be replayed. */
  function replay(lastEventId: string): StreamEntry[] | null {
    const match = ID_RE.exec(lastEventId.trim());
    if (match === null || match[1] !== epoch) {
      return null;
    }
    const seq = Number(match[2]);
    const oldest = buffer[0]?.seq ?? head + 1;
    if (seq > head || seq < oldest - 1) {
      return null;
    }
    return buffer.slice(buffer.length - (head - seq));
  }

  return {
    epoch,
    get head() {
      return head;
    },
    get clientCount() {
      return clients.size;
    },
    attach(lastEventId, client) {
      clients.add(client);
      const detach = () => {
        clients.delete(client);
      };
      if (lastEventId === undefined || lastEventId === "") {
        return { backlog: [], resync: false, detach };
      }
      const missed = replay(lastEventId);
      if (missed !== null) {
        return { backlog: missed, resync: false, detach };
      }
      // Carries the current id, so the client's next reconnect replays from here.
      const id = idOf(head);
      const resync: StreamEntry = {
        seq: head,
        id,
        frame: encodeFrame(id, { type: "resync", payload: {} }),
      };
      return { backlog: [resync], resync: true, detach };
    },
    close() {
      unsubscribe?.();
      unsubscribe = null;
      for (const client of [...clients]) {
        clients.delete(client);
        client.close();
      }
    },
  };
}
