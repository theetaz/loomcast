import { CLOSE_CODES, type ParseFailure } from "@loomcast/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BridgeConnection,
  type ConnectionHandlers,
  type HelloOk,
  type HelloPayload,
  type ServerJobMessage,
} from "../src/connection";
import { silentLogger } from "../src/logger";
import { bridgeUrl } from "../src/server-url";
import { FakeBridge } from "./fake-bridge";
import { ids, TEST_TOKEN } from "./helpers";

const FAST_BACKOFF = { initialMs: 5, maxMs: 20, resetAfterMs: 60_000 };

const hello: HelloPayload = {
  protocol: 1,
  agentVersion: "0.1.0",
  platform: "darwin-arm64",
  jobTypes: ["system.ping"],
  credits: { producer: 1, render: 1 },
  resume: [],
};

class RecordingHandlers implements ConnectionHandlers {
  readonly readies: HelloOk[] = [];
  readonly messages: ServerJobMessage[] = [];
  readonly invalid: ParseFailure[] = [];
  disconnects = 0;
  hello = (): HelloPayload => hello;
  ready = (message: HelloOk): void => {
    this.readies.push(message);
  };
  message = (message: ServerJobMessage): void => {
    this.messages.push(message);
  };
  invalidFrame = (_frame: string, failure: ParseFailure): void => {
    this.invalid.push(failure);
  };
  disconnected = (): void => {
    this.disconnects += 1;
  };
}

let bridge: FakeBridge;
let connection: BridgeConnection | undefined;

beforeEach(async () => {
  bridge = await FakeBridge.start();
});

afterEach(async () => {
  connection?.stop();
  await connection?.done;
  connection = undefined;
  await bridge.close();
});

function connect(
  handlers: ConnectionHandlers,
  overrides: Partial<{ token: string; deadServerMs: number }> = {},
): BridgeConnection {
  connection = new BridgeConnection({
    url: bridgeUrl(bridge.serverUrl),
    token: overrides.token ?? TEST_TOKEN,
    handlers,
    log: silentLogger,
    backoff: FAST_BACKOFF,
    deadServerMs: overrides.deadServerMs,
  });
  connection.start();
  return connection;
}

/** Resolves once `connection` has received `hello.ok` `count` times. */
async function readyCount(handlers: RecordingHandlers, count: number): Promise<void> {
  await bridge.waitFor("hello", () => bridge.messages("hello").length >= count);
  await expect.poll(() => handlers.readies.length).toBe(count);
}

describe("bridge connection", () => {
  it("authenticates with the bearer token and sends hello", async () => {
    const handlers = new RecordingHandlers();
    const conn = connect(handlers);
    const message = await bridge.waitFor("hello");

    expect(bridge.authHeaders).toEqual([`Bearer ${TEST_TOKEN}`]);
    expect(message.payload).toEqual(hello);
    await expect.poll(() => conn.ready).toBe(true);
    expect(handlers.readies[0]?.payload.deviceId).toBe(ids.device);
  });

  it("only sends job traffic on a ready connection", async () => {
    const handlers = new RecordingHandlers();
    const conn = connect(handlers);
    expect(conn.send({ type: "job.heartbeat", payload: { jobIds: [] } })).toBe(false);
    await readyCount(handlers, 1);
    expect(conn.send({ type: "job.heartbeat", payload: { jobIds: [ids.job] } })).toBe(true);
    const heartbeat = await bridge.waitFor("job.heartbeat");
    expect(heartbeat.payload.jobIds).toEqual([ids.job]);
  });

  it("routes server messages and reports invalid frames without closing", async () => {
    const handlers = new RecordingHandlers();
    connect(handlers);
    await readyCount(handlers, 1);
    bridge.sendRaw("{not json");
    bridge.cancel(ids.job);
    await expect.poll(() => handlers.messages.length).toBe(1);
    expect(handlers.messages[0]?.type).toBe("job.cancel");
    expect(handlers.invalid[0]?.reason).toBe("invalid_json");
    expect(bridge.connections).toBe(1);
  });

  it("reconnects after the server drops the socket", async () => {
    const handlers = new RecordingHandlers();
    connect(handlers);
    await readyCount(handlers, 1);
    bridge.dropConnection();
    await readyCount(handlers, 2);
    expect(handlers.disconnects).toBe(1);
    expect(bridge.connections).toBe(2);
  });

  it("answers pings and drops a server that stops pinging", async () => {
    const handlers = new RecordingHandlers();
    connect(handlers, { deadServerMs: 150 });
    await readyCount(handlers, 1);
    bridge.ping();
    await expect.poll(() => bridge.pongs).toBe(1);
    // No further pings: the agent gives up on the socket and reconnects.
    await readyCount(handlers, 2);
    expect(handlers.disconnects).toBeGreaterThanOrEqual(1);
  });

  it.each([
    [CLOSE_CODES.unauthorized, "unauthorized"],
    [CLOSE_CODES.revoked, "revoked"],
    [CLOSE_CODES.superseded, "superseded"],
    [CLOSE_CODES.unsupportedProtocol, "unsupported_protocol"],
  ] as const)("stops for good on close code %i", async (code, reason) => {
    const handlers = new RecordingHandlers();
    const conn = connect(handlers);
    await readyCount(handlers, 1);
    bridge.closeWith(code);
    await expect(conn.done).resolves.toBe(reason);
    expect(bridge.connections).toBe(1);
  });

  it("stops when the upgrade is refused with 401", async () => {
    const conn = connect(new RecordingHandlers(), {
      token: `lc_dev_${"Z".repeat(43)}`,
    });
    await expect(conn.done).resolves.toBe("unauthorized");
    expect(bridge.connections).toBe(0);
  });

  it("keeps retrying when the upgrade fails with a server error", async () => {
    bridge.rejectUpgradesWith = 502;
    const handlers = new RecordingHandlers();
    connect(handlers);
    await expect.poll(() => bridge.authHeaders.length).toBeGreaterThanOrEqual(3);
    bridge.rejectUpgradesWith = null;
    await readyCount(handlers, 1);
  });

  it("closes cleanly on stop", async () => {
    const handlers = new RecordingHandlers();
    const conn = connect(handlers);
    await readyCount(handlers, 1);
    conn.stop();
    await expect(conn.done).resolves.toBe("stopped");
    expect(conn.ready).toBe(false);
  });
});
