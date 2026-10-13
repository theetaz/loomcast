import { randomUUID } from "node:crypto";
import {
  DEVICE_TOKEN_RE,
  DeviceSchema,
  LiveEventSchema,
  listSchema,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_RE,
  PAIRING_CODE_TTL_MS,
  PairingCodeSchema,
  type PairRequest,
  PairResponseSchema,
} from "@loomcast/contracts";
import { apiTokens, auditLog, devices, pairingCodes, users } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterModule } from "../src/deps";
import type { BusEvent } from "../src/lib/bus";
import { sha256Hex } from "../src/lib/crypto";
import { generatePairingCode, hashPairingCode, PAIRING_LIMITS } from "../src/modules/devices";
import { createTokensService } from "../src/modules/tokens/service";
import type { AppEnv } from "../src/types";
import {
  createTestApp,
  createTestClock,
  errorCode,
  insertUser,
  login,
  type RequestOptions,
  send,
  type TestApp,
  testIp,
} from "./support";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

const DevicesListSchema = listSchema(DeviceSchema);

function pairBody(code: string, overrides: Partial<PairRequest> = {}): PairRequest {
  return {
    code,
    name: "Studio Mac",
    platform: "darwin-arm64",
    agentVersion: "0.1.0",
    ...overrides,
  };
}

/** Sends `POST /api/bridge/pair` the way the studio agent does: JSON, no Origin, no cookie. */
function pairRequest(app: TestApp["app"], body: unknown, options: RequestOptions = {}) {
  return send(app, "POST", "/api/bridge/pair", { origin: null, body, ...options });
}

async function signedIn(test: TestApp, ip?: string) {
  const user = await insertUser(testDb.db);
  const { cookie } = await login(test.app, user.email, undefined, ip);
  return { user, cookie };
}

async function createCode(test: TestApp, cookie: string): Promise<string> {
  const response = await send(test.app, "POST", "/api/devices/pairing-codes", { cookie });
  expect(response.status).toBe(201);
  return PairingCodeSchema.parse(await response.json()).code;
}

async function pairDevice(test: TestApp, cookie: string, ip = testIp(10)) {
  const code = await createCode(test, cookie);
  const response = await pairRequest(test.app, pairBody(code), { ip });
  expect(response.status).toBe(201);
  return PairResponseSchema.parse(await response.json());
}

function recordBus(test: TestApp) {
  const events: BusEvent[] = [];
  test.bus.subscribe("device.revoked", (event) => void events.push(event));
  test.bus.subscribe("device.status", (event) => void events.push(event));
  const live: unknown[] = [];
  test.bus.subscribeLive((event) => void live.push(event));
  return { events, live };
}

async function auditRows(action: string, targetId: string) {
  return testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)));
}

async function failedPairReasons(ip: string): Promise<unknown[]> {
  const rows = await testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "device.pair.failed"), eq(auditLog.ip, ip)));
  return rows.map((row) => row.data?.reason);
}

describe("pairing codes", () => {
  it("generates XXXX-XXXX codes over the unambiguous alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(PAIRING_CODE_RE);
      for (const char of code.replace("-", "")) {
        expect(PAIRING_CODE_ALPHABET).toContain(char);
      }
      seen.add(code);
    }
    expect(seen.size).toBe(500);
  });

  it("creates a single code, stores only its hash and expires it in 10 minutes", async () => {
    const test = createTestApp(testDb.db);
    const { user, cookie } = await signedIn(test);

    const response = await send(test.app, "POST", "/api/devices/pairing-codes", { cookie });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const created = PairingCodeSchema.parse(await response.json());
    expect(created.code).toMatch(PAIRING_CODE_RE);
    expect(new Date(created.expiresAt).getTime()).toBe(
      test.clock.now().getTime() + PAIRING_CODE_TTL_MS,
    );

    const rows = await testDb.db
      .select()
      .from(pairingCodes)
      .where(eq(pairingCodes.createdBy, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codeHash).toBe(hashPairingCode(created.code));
    expect(rows[0]?.usedAt).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(created.code);
    expect(JSON.stringify(rows)).not.toContain(created.code.replace("-", ""));

    const audits = await auditRows("device.pairing_code.created", rows[0]?.id ?? "");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(user.id);
    expect(JSON.stringify(audits)).not.toContain(created.code);
  });

  it("needs a session and the app origin", async () => {
    const test = createTestApp(testDb.db);
    const { cookie } = await signedIn(test);
    const anonymous = await send(test.app, "POST", "/api/devices/pairing-codes");
    expect(anonymous.status).toBe(401);
    const crossSite = await send(test.app, "POST", "/api/devices/pairing-codes", {
      cookie,
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
  });

  it("drops the user's expired unused codes when a new one is created", async () => {
    const test = createTestApp(testDb.db);
    const { user, cookie } = await signedIn(test);
    await createCode(test, cookie);
    test.clock.advance(PAIRING_CODE_TTL_MS);
    await createCode(test, cookie);
    const rows = await testDb.db
      .select()
      .from(pairingCodes)
      .where(eq(pairingCodes.createdBy, user.id));
    expect(rows).toHaveLength(1);
  });

  it("limits code creation per user", async () => {
    const test = createTestApp(testDb.db);
    const { cookie } = await signedIn(test);
    for (let i = 0; i < PAIRING_LIMITS.codesPerUser.capacity; i++) {
      await createCode(test, cookie);
    }
    const limited = await send(test.app, "POST", "/api/devices/pairing-codes", { cookie });
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("rate_limited");
  });
});

describe("POST /api/bridge/pair", () => {
  it("exchanges a code for a device and a bridge token stored only as a hash", async () => {
    const test = createTestApp(testDb.db);
    const { user, cookie } = await signedIn(test);
    const code = await createCode(test, cookie);
    const ip = testIp(21);

    // The agent may send the code as typed: lower case with surrounding spaces.
    const response = await pairRequest(test.app, pairBody(` ${code.toLowerCase()} `), { ip });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const paired = PairResponseSchema.parse(await response.json());
    expect(paired.token).toMatch(DEVICE_TOKEN_RE);

    const [device] = await testDb.db.select().from(devices).where(eq(devices.id, paired.deviceId));
    expect(device).toMatchObject({
      name: "Studio Mac",
      platform: "darwin-arm64",
      agentVersion: "0.1.0",
      createdBy: user.id,
      revokedAt: null,
    });

    const [token] = await testDb.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, device?.tokenId ?? ""));
    expect(token).toMatchObject({ kind: "device", userId: user.id, scopes: ["bridge"] });
    expect(token?.tokenHash).toBe(sha256Hex(paired.token));
    expect(JSON.stringify(token)).not.toContain(paired.token);

    const verified = await createTokensService({ db: testDb.db, clock: test.clock }).verify(
      paired.token,
      "device",
    );
    expect(verified).toMatchObject({ id: token?.id, kind: "device", scopes: ["bridge"] });

    const [codeRow] = await testDb.db
      .select()
      .from(pairingCodes)
      .where(eq(pairingCodes.codeHash, hashPairingCode(code)));
    expect(codeRow?.usedAt).not.toBeNull();
    expect(codeRow?.deviceId).toBe(paired.deviceId);

    const audits = await auditRows("device.paired", paired.deviceId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: "device", ip });
    expect(audits[0]?.data).toMatchObject({ pairedBy: user.id, tokenId: token?.id });
    expect(JSON.stringify(audits)).not.toContain(paired.token);
    expect(JSON.stringify(audits)).not.toContain(code);
  });

  it("works once and only once per code", async () => {
    const test = createTestApp(testDb.db);
    const { cookie } = await signedIn(test);
    const code = await createCode(test, cookie);
    const ip = testIp(22);

    const first = await pairRequest(test.app, pairBody(code), { ip });
    expect(first.status).toBe(201);
    const second = await pairRequest(test.app, pairBody(code, { name: "Other Mac" }), { ip });
    expect(second.status).toBe(401);
    expect(await errorCode(second)).toBe("unauthorized");
    expect(await failedPairReasons(ip)).toEqual(["used"]);

    const rows = await testDb.db
      .select()
      .from(pairingCodes)
      .innerJoin(devices, eq(devices.id, pairingCodes.deviceId))
      .where(eq(pairingCodes.codeHash, hashPairingCode(code)));
    expect(rows).toHaveLength(1);
  });

  it("lets only one of two concurrent requests redeem a code", async () => {
    const test = createTestApp(testDb.db);
    const { user, cookie } = await signedIn(test);
    const code = await createCode(test, cookie);

    const responses = await Promise.all([
      pairRequest(test.app, pairBody(code, { name: "Mac A" }), { ip: testIp(23) }),
      pairRequest(test.app, pairBody(code, { name: "Mac B" }), { ip: testIp(24) }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 401]);
    const created = await testDb.db.select().from(devices).where(eq(devices.createdBy, user.id));
    expect(created).toHaveLength(1);
    const tokens = await testDb.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, user.id), eq(apiTokens.kind, "device")));
    expect(tokens).toHaveLength(1);
  });

  it("accepts a code until it expires after 10 minutes", async () => {
    const test = createTestApp(testDb.db, { clock: createTestClock() });
    const { cookie } = await signedIn(test);
    const ip = testIp(25);

    const early = await createCode(test, cookie);
    test.clock.advance(PAIRING_CODE_TTL_MS - 1_000);
    expect((await pairRequest(test.app, pairBody(early), { ip })).status).toBe(201);

    const late = await createCode(test, cookie);
    test.clock.advance(PAIRING_CODE_TTL_MS);
    const expired = await pairRequest(test.app, pairBody(late), { ip });
    expect(expired.status).toBe(401);
    expect(await failedPairReasons(ip)).toEqual(["expired"]);

    const [row] = await testDb.db
      .select()
      .from(pairingCodes)
      .where(eq(pairingCodes.codeHash, hashPairingCode(late)));
    expect(row?.usedAt).toBeNull();
    expect(row?.deviceId).toBeNull();
  });

  it("refuses unknown codes with the same answer", async () => {
    const test = createTestApp(testDb.db);
    const ip = testIp(26);
    const response = await pairRequest(test.app, pairBody(generatePairingCode()), { ip });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "The pairing code is invalid, already used or expired.",
      },
    });
    expect(await failedPairReasons(ip)).toEqual(["unknown_code"]);
  });

  it("refuses a code whose creator was disabled", async () => {
    const test = createTestApp(testDb.db);
    const { user, cookie } = await signedIn(test);
    const code = await createCode(test, cookie);
    await testDb.db
      .update(users)
      .set({ disabledAt: test.clock.now() })
      .where(eq(users.id, user.id));
    const ip = testIp(27);

    const response = await pairRequest(test.app, pairBody(code), { ip });
    expect(response.status).toBe(401);
    expect(await failedPairReasons(ip)).toEqual(["user_disabled"]);
    const created = await testDb.db.select().from(devices).where(eq(devices.createdBy, user.id));
    expect(created).toHaveLength(0);
  });

  it("validates the request body", async () => {
    const test = createTestApp(testDb.db);
    // A code without its separator, and the agent fields missing.
    const unformatted = generatePairingCode().replace("-", "");
    const malformed = await pairRequest(test.app, { code: unformatted, name: "Mac" });
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe("validation_failed");
    const notJson = await pairRequest(test.app, "{", { ip: testIp(28) });
    expect(notJson.status).toBe(400);
    expect(await errorCode(notJson)).toBe("bad_request");
  });

  it("refuses browsers from other origins and non-JSON bodies", async () => {
    const test = createTestApp(testDb.db);
    const { cookie } = await signedIn(test);
    const code = await createCode(test, cookie);

    const crossSite = await pairRequest(test.app, pairBody(code), {
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
    const form = await pairRequest(test.app, `code=${code}`, {
      contentType: "application/x-www-form-urlencoded",
    });
    expect(form.status).toBe(403);

    // Neither attempt consumed the code.
    expect((await pairRequest(test.app, pairBody(code))).status).toBe(201);
  });

  it("allows 10 attempts a minute per client address", async () => {
    const test = createTestApp(testDb.db, { clock: createTestClock() });
    const ip = testIp(29);
    const { capacity, intervalMs } = PAIRING_LIMITS.pairPerIp;
    expect(capacity).toBe(10);
    expect(intervalMs).toBe(60_000);

    for (let i = 0; i < capacity; i++) {
      const response = await pairRequest(test.app, pairBody(generatePairingCode()), { ip });
      expect(response.status).toBe(401);
    }
    const { cookie } = await signedIn(test);
    const code = await createCode(test, cookie);
    const limited = await pairRequest(test.app, pairBody(code), { ip });
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    // Other addresses are not affected, and the bucket refills over the minute.
    const other = await pairRequest(test.app, pairBody(generatePairingCode()), { ip: testIp(30) });
    expect(other.status).toBe(401);
    test.clock.advance(intervalMs);
    expect((await pairRequest(test.app, pairBody(code), { ip })).status).toBe(201);
  });
});

describe("GET /api/devices", () => {
  it("lists paired devices with their online state from the presence registry", async () => {
    const online = new Set<string>();
    // Stands in for the bridge module, which replaces the default presence the same way.
    const presence: RegisterModule = (app, deps) => {
      deps.presence.connectedDevices = () => online;
      const router = new Hono<AppEnv>();
      app.route("/", router);
      return router;
    };
    const test = createTestApp(testDb.db, { modules: [presence] });
    const { cookie } = await signedIn(test);
    const first = await pairDevice(test, cookie);
    test.clock.advance(1_000);
    const second = await pairDevice(test, cookie);
    online.add(second.deviceId);

    const response = await send(test.app, "GET", "/api/devices", { cookie });
    expect(response.status).toBe(200);
    const { items } = DevicesListSchema.parse(await response.json());
    const ours = items.filter((item) => [first.deviceId, second.deviceId].includes(item.id));
    expect(ours.map((item) => [item.id, item.online])).toEqual([
      [second.deviceId, true],
      [first.deviceId, false],
    ]);
    expect(ours[0]).toMatchObject({
      name: "Studio Mac",
      platform: "darwin-arm64",
      agentVersion: "0.1.0",
      lastSeenAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(items)).not.toContain(second.token);
  });

  it("reports every device offline by default", async () => {
    const test = createTestApp(testDb.db);
    const { cookie } = await signedIn(test);
    await pairDevice(test, cookie);
    const response = await send(test.app, "GET", "/api/devices", { cookie });
    const { items } = DevicesListSchema.parse(await response.json());
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => !item.online)).toBe(true);
  });

  it("needs a session", async () => {
    const test = createTestApp(testDb.db);
    expect((await send(test.app, "GET", "/api/devices")).status).toBe(401);
  });
});

describe("DELETE /api/devices/:id", () => {
  it("revokes the device and its token, then tells the bridge and the browsers", async () => {
    const test = createTestApp(testDb.db);
    const { user, cookie } = await signedIn(test);
    const paired = await pairDevice(test, cookie);
    const [before] = await testDb.db.select().from(devices).where(eq(devices.id, paired.deviceId));
    const tokens = createTokensService({ db: testDb.db, clock: test.clock });
    expect(await tokens.verify(paired.token, "device")).not.toBeNull();
    const bus = recordBus(test);

    const response = await send(test.app, "DELETE", `/api/devices/${paired.deviceId}`, {
      cookie,
      ip: testIp(40),
    });
    expect(response.status).toBe(204);

    const [device] = await testDb.db.select().from(devices).where(eq(devices.id, paired.deviceId));
    expect(device?.revokedAt).not.toBeNull();
    const [token] = await testDb.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, before?.tokenId ?? ""));
    expect(token?.revokedAt).not.toBeNull();
    expect(await tokens.verify(paired.token, "device")).toBeNull();

    expect(bus.events).toEqual([
      {
        type: "device.revoked",
        payload: { deviceId: paired.deviceId, tokenId: before?.tokenId },
      },
      {
        type: "device.status",
        payload: { deviceId: paired.deviceId, online: false, lastSeenAt: null },
      },
    ]);
    // Browsers see the status change but never the internal revocation event.
    expect(bus.live).toHaveLength(1);
    expect(LiveEventSchema.parse(bus.live[0]).type).toBe("device.status");

    const audits = await auditRows("device.revoked", paired.deviceId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: "user", actorId: user.id, ip: testIp(40) });

    const list = await send(test.app, "GET", "/api/devices", { cookie });
    const { items } = DevicesListSchema.parse(await list.json());
    expect(items.map((item) => item.id)).not.toContain(paired.deviceId);
  });

  it("is idempotent and does not announce a second revocation", async () => {
    const test = createTestApp(testDb.db);
    const { cookie } = await signedIn(test);
    const paired = await pairDevice(test, cookie);
    const path = `/api/devices/${paired.deviceId}`;
    expect((await send(test.app, "DELETE", path, { cookie })).status).toBe(204);

    const bus = recordBus(test);
    expect((await send(test.app, "DELETE", path, { cookie })).status).toBe(204);
    expect(bus.events).toEqual([]);
    expect(await auditRows("device.revoked", paired.deviceId)).toHaveLength(1);
  });

  it("lets any signed-in user of the workspace revoke a device", async () => {
    const test = createTestApp(testDb.db);
    const { cookie: pairer } = await signedIn(test);
    const { cookie: other } = await signedIn(test);
    const paired = await pairDevice(test, pairer);
    const response = await send(test.app, "DELETE", `/api/devices/${paired.deviceId}`, {
      cookie: other,
    });
    expect(response.status).toBe(204);
  });

  it("answers 404 for unknown and malformed ids", async () => {
    const test = createTestApp(testDb.db);
    const { cookie } = await signedIn(test);
    const unknown = await send(test.app, "DELETE", `/api/devices/${randomUUID()}`, {
      cookie,
    });
    expect(unknown.status).toBe(404);
    const malformed = await send(test.app, "DELETE", "/api/devices/not-an-id", { cookie });
    expect(malformed.status).toBe(404);
  });

  it("needs a session and the app origin", async () => {
    const test = createTestApp(testDb.db);
    const { cookie } = await signedIn(test);
    const paired = await pairDevice(test, cookie);
    const path = `/api/devices/${paired.deviceId}`;
    expect((await send(test.app, "DELETE", path)).status).toBe(401);
    expect((await send(test.app, "DELETE", path, { cookie, origin: null })).status).toBe(403);
    const [device] = await testDb.db.select().from(devices).where(eq(devices.id, paired.deviceId));
    expect(device?.revokedAt).toBeNull();
  });
});
