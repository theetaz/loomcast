import { CLOSE_CODES } from "@loomcast/contracts";
import { apiTokens, auditLog, devices, users } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type BridgeServer,
  FakeAgent,
  pairDevice,
  startBridgeServer,
  UpgradeRefused,
} from "../bridge-support";
import { insertUser, login, send } from "../support";

/** Disabling a user ends everything they hold, including live bridge connections of their devices. */

let testDb: TestDb;
const servers: BridgeServer[] = [];
const agents: FakeAgent[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
});

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    agent.ws.terminate();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

afterAll(async () => {
  await testDb.drop();
});

async function start(): Promise<BridgeServer> {
  const server = await startBridgeServer(testDb.db);
  servers.push(server);
  return server;
}

async function connect(server: BridgeServer, secret: string): Promise<FakeAgent> {
  const agent = await FakeAgent.connect(server.port, { secret });
  agents.push(agent);
  return agent;
}

describe("disabling a user", () => {
  it("revokes the devices they paired and closes their bridge connections at once", async () => {
    const server = await start();
    const owner = await insertUser(testDb.db, { role: "owner" });
    const admin = await insertUser(testDb.db);
    const other = await insertUser(testDb.db);
    const theirs = await pairDevice(testDb.db, admin.id, "Admin Mac");
    const kept = await pairDevice(testDb.db, other.id, "Other Mac");

    const theirAgent = await connect(server, theirs.secret);
    await theirAgent.hello();
    const keptAgent = await connect(server, kept.secret);
    await keptAgent.hello();

    const { cookie } = await login(server.app, owner.email);
    const response = await send(server.app, "POST", `/api/users/${admin.id}/disable`, { cookie });
    expect(response.status).toBe(200);

    expect((await theirAgent.closed).code).toBe(CLOSE_CODES.revoked);
    await vi.waitFor(() => {
      expect(server.hub.connectedDevices().has(theirs.deviceId)).toBe(false);
    });
    expect(server.hub.connectedDevices().has(kept.deviceId)).toBe(true);

    const [device] = await testDb.db.select().from(devices).where(eq(devices.id, theirs.deviceId));
    expect(device?.revokedAt).not.toBeNull();
    const [token] = await testDb.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, theirs.tokenId));
    expect(token?.revokedAt).not.toBeNull();
    const [keptDevice] = await testDb.db
      .select()
      .from(devices)
      .where(eq(devices.id, kept.deviceId));
    expect(keptDevice?.revokedAt).toBeNull();

    // The device cannot come back.
    await expect(FakeAgent.connect(server.port, { secret: theirs.secret })).rejects.toBeInstanceOf(
      UpgradeRefused,
    );

    expect(server.events).toEqual(
      expect.arrayContaining([
        {
          type: "device.revoked",
          payload: { deviceId: theirs.deviceId, tokenId: theirs.tokenId },
        },
      ]),
    );
    const [entry] = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.disabled"), eq(auditLog.targetId, admin.id)));
    expect(entry?.data).toMatchObject({ devicesRevoked: [theirs.deviceId] });
  });

  it("publishes nothing when the user is already disabled", async () => {
    const server = await start();
    const owner = await insertUser(testDb.db, { role: "owner" });
    const admin = await insertUser(testDb.db);
    await pairDevice(testDb.db, admin.id, "Stale Mac");
    await testDb.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, admin.id));
    const { cookie } = await login(server.app, owner.email);
    const response = await send(server.app, "POST", `/api/users/${admin.id}/disable`, { cookie });
    expect(response.status).toBe(200);
    expect(server.events.filter((event) => event.type === "device.revoked")).toEqual([]);
  });
});
