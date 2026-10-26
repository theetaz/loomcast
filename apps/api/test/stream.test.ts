import { randomUUID } from "node:crypto";
import { type LiveEvent, parseLiveEvent, type Workspace } from "@loomcast/contracts";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/lib/bus";
import { createLiveHub, STREAM_HEARTBEAT_MS, type StreamEntry } from "../src/modules/stream";
import { createTestApp, insertUser, login, send, type TestApp } from "./support";

let testDb: TestDb;
let t: TestApp;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDb();
  t = createTestApp(testDb.db);
  const user = await insertUser(testDb.db);
  ({ cookie } = await login(t.app, user.email));
});

afterAll(async () => {
  await t.deps.lifecycle.close();
  await testDb.drop();
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeWorkspace(name = "Live"): Workspace {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    slug: `live-${randomUUID().slice(0, 8)}`,
    name,
    description: null,
    status: "active",
    color: "thread",
    iconUrl: null,
    timeZone: "UTC",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

function workspaceEvent(name?: string): LiveEvent {
  return { type: "workspace.updated", payload: { workspace: fakeWorkspace(name) } };
}

/** One parsed server-sent event frame. */
interface Frame {
  id?: string;
  data?: string;
  event?: string;
  retry?: number;
  comment?: string;
}

function parseFrame(raw: string): Frame {
  const frame: Frame = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(":");
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "id" || field === "data" || field === "event") {
      frame[field] = value;
    } else if (field === "retry") {
      frame.retry = Number(value);
    }
  }
  return frame;
}

/** Reads a live stream response frame by frame. */
class StreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffered = "";
  done = false;

  constructor(readonly response: Response) {
    if (response.body === null) {
      throw new Error("the stream response has no body");
    }
    this.reader = response.body.getReader();
  }

  /** The next frame, or null when the stream ended. */
  async next(timeoutMs = 5_000): Promise<Frame | null> {
    for (;;) {
      const end = this.buffered.indexOf("\n\n");
      if (end !== -1) {
        const raw = this.buffered.slice(0, end);
        this.buffered = this.buffered.slice(end + 2);
        return parseFrame(raw);
      }
      if (this.done) {
        return null;
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no frame within the timeout")), timeoutMs);
      });
      try {
        const chunk = await Promise.race([this.reader.read(), timeout]);
        if (chunk.done) {
          this.done = true;
        } else {
          this.buffered += this.decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** The next frame that carries an event, skipping comments and `retry`. */
  async nextEvent(): Promise<{ id: string; event: LiveEvent }> {
    for (;;) {
      const frame = await this.next();
      if (frame === null) {
        throw new Error("the stream ended");
      }
      if (frame.data !== undefined) {
        const event = parseLiveEvent(frame.data);
        if (event === null || frame.id === undefined) {
          throw new Error(`unexpected frame ${JSON.stringify(frame)}`);
        }
        return { id: frame.id, event };
      }
    }
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

async function openStream(headers: Record<string, string> = {}, app = t.app) {
  const response = await send(app, "GET", "/api/stream", { cookie, headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const stream = new StreamReader(response);
  // The first frame sets the reconnect delay; once it arrives the client is attached.
  expect((await stream.next())?.retry).toBeGreaterThan(0);
  return stream;
}

function closedLogs(app: TestApp): { clients: number }[] {
  return app.logs
    .map((line) => JSON.parse(line) as { msg?: string; clients?: number })
    .filter((entry) => entry.msg === "live stream closed")
    .map((entry) => ({ clients: entry.clients ?? -1 }));
}

describe("GET /api/stream", () => {
  it("requires a session", async () => {
    const response = await send(t.app, "GET", "/api/stream");
    expect(response.status).toBe(401);
  });

  it("delivers live bus events with an id and leaves internal events out", async () => {
    const stream = await openStream();
    expect(stream.response.headers.get("cache-control")).toBe("no-cache");
    expect(stream.response.headers.get("x-accel-buffering")).toBe("no");

    t.bus.publish({
      type: "job.enqueued",
      payload: {
        jobId: randomUUID(),
        type: "system.ping",
        workspaceId: randomUUID(),
        deviceAffinity: null,
      },
    });
    const first = workspaceEvent("First");
    const second = workspaceEvent("Second");
    t.bus.publish(first);
    t.bus.publish(second);

    const a = await stream.nextEvent();
    const b = await stream.nextEvent();
    expect(a.event).toEqual(first);
    expect(b.event).toEqual(second);
    const seq = (id: string) => Number(id.split("-")[1]);
    expect(seq(b.id)).toBe(seq(a.id) + 1);
    expect(a.id.split("-")[0]).toBe(b.id.split("-")[0]);
    await stream.cancel();
  });

  it("fans one event out to every connected client", async () => {
    const one = await openStream();
    const two = await openStream();
    const event = workspaceEvent("Fan out");
    t.bus.publish(event);
    const [a, b] = await Promise.all([one.nextEvent(), two.nextEvent()]);
    expect(a).toEqual(b);
    expect(a.event).toEqual(event);
    await Promise.all([one.cancel(), two.cancel()]);
  });

  it("replays the events after Last-Event-ID, then continues live", async () => {
    const first = await openStream();
    const events = [workspaceEvent("R1"), workspaceEvent("R2"), workspaceEvent("R3")];
    for (const event of events) {
      t.bus.publish(event);
    }
    const received = [];
    for (let index = 0; index < events.length; index += 1) {
      received.push(await first.nextEvent());
    }
    await first.cancel();

    const lastSeen = received[0]?.id ?? "";
    const resumed = await openStream({ "Last-Event-ID": lastSeen });
    expect(await resumed.nextEvent()).toEqual(received[1]);
    expect(await resumed.nextEvent()).toEqual(received[2]);

    const live = workspaceEvent("After replay");
    t.bus.publish(live);
    expect((await resumed.nextEvent()).event).toEqual(live);
    await resumed.cancel();
  });

  it("sends resync, with the current id, for an id it cannot replay", async () => {
    const stream = await openStream();
    t.bus.publish(workspaceEvent("Head"));
    const head = await stream.nextEvent();
    await stream.cancel();

    for (const lastEventId of ["0000-1", "garbage", `${head.id.split("-")[0]}-999999`]) {
      const resumed = await openStream({ "Last-Event-ID": lastEventId });
      const resync = await resumed.nextEvent();
      expect(resync.event).toEqual({ type: "resync", payload: {} });
      expect(resync.id).toBe(head.id);
      await resumed.cancel();
    }
  });

  it("detaches the client when the connection is aborted", async () => {
    const own = createTestApp(testDb.db);
    const { cookie: ownCookie } = await login(own.app, (await insertUser(testDb.db)).email);
    const response = await send(own.app, "GET", "/api/stream", { cookie: ownCookie });
    const stream = new StreamReader(response);
    await stream.next();
    await stream.cancel();
    await vi.waitFor(() => expect(closedLogs(own)).toEqual([{ clients: 0 }]));
    // Publishing after the abort reaches no client and raises nothing.
    own.bus.publish(workspaceEvent("Nobody listens"));
    await own.deps.lifecycle.close();
  });

  it("sends a heartbeat comment while idle", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = await openStream();
    vi.advanceTimersByTime(STREAM_HEARTBEAT_MS);
    expect(await stream.next()).toEqual({ comment: "heartbeat" });
    vi.advanceTimersByTime(STREAM_HEARTBEAT_MS);
    expect(await stream.next()).toEqual({ comment: "heartbeat" });
    await stream.cancel();
  });

  it("ends open streams on shutdown", async () => {
    const own = createTestApp(testDb.db);
    const { cookie: ownCookie } = await login(own.app, (await insertUser(testDb.db)).email);
    const response = await send(own.app, "GET", "/api/stream", { cookie: ownCookie });
    const stream = new StreamReader(response);
    await stream.next();
    await own.deps.lifecycle.close();
    expect(await stream.next()).toBeNull();
  });
});

describe("live hub", () => {
  function setup(bufferSize = 3) {
    const bus = createEventBus();
    const hub = createLiveHub(bus, { bufferSize, epoch: "e1" });
    const publish = (count: number) => {
      for (let index = 0; index < count; index += 1) {
        bus.publish(workspaceEvent(`Event ${index}`));
      }
    };
    const client = () => {
      const delivered: StreamEntry[] = [];
      let closed = false;
      return {
        delivered,
        isClosed: () => closed,
        client: {
          deliver: (entry: StreamEntry) => delivered.push(entry),
          close: () => (closed = true),
        },
      };
    };
    return { bus, hub, publish, client };
  }

  it("numbers events from 1 within its epoch", () => {
    const { hub, publish, client } = setup();
    const c = client();
    hub.attach(undefined, c.client);
    publish(2);
    expect(c.delivered.map((entry) => entry.id)).toEqual(["e1-1", "e1-2"]);
    expect(hub.head).toBe(2);
  });

  it("replays what is still buffered and resyncs anything older", () => {
    const { hub, publish, client } = setup(3);
    publish(5); // buffer holds 3, 4 and 5
    const ids = (lastEventId: string) => {
      const attachment = hub.attach(lastEventId, client().client);
      attachment.detach();
      return attachment.resync ? "resync" : attachment.backlog.map((entry) => entry.seq);
    };
    expect(ids("e1-2")).toEqual([3, 4, 5]);
    expect(ids("e1-4")).toEqual([5]);
    expect(ids("e1-5")).toEqual([]);
    expect(ids("e1-1")).toBe("resync");
    expect(ids("e1-6")).toBe("resync");
    expect(ids("e2-5")).toBe("resync");
    expect(ids("5")).toBe("resync");
  });

  it("replays from 0 before the first event is evicted", () => {
    const { hub, publish } = setup(3);
    publish(2);
    const attachment = hub.attach("e1-0", { deliver: () => {}, close: () => {} });
    expect(attachment.backlog.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("stops delivering after detach and closes clients on close", () => {
    const { hub, publish, client } = setup();
    const kept = client();
    const dropped = client();
    hub.attach(undefined, kept.client);
    hub.attach(undefined, dropped.client).detach();
    expect(hub.clientCount).toBe(1);
    publish(1);
    expect(kept.delivered).toHaveLength(1);
    expect(dropped.delivered).toHaveLength(0);

    hub.close();
    expect(kept.isClosed()).toBe(true);
    expect(hub.clientCount).toBe(0);
    publish(1);
    expect(kept.delivered).toHaveLength(1);
  });
});
