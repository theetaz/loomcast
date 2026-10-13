import { randomUUID } from "node:crypto";
import { JOB_TOKEN_RE, TOKEN_PREFIXES } from "@loomcast/contracts";
import { apiTokens, jobs, projects } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEventBus } from "../src/lib/bus";
import { sha256Hex } from "../src/lib/crypto";
import { createLogger } from "../src/lib/logger";
import { createJobLifecycle } from "../src/modules/jobs/lifecycle";
import { createTokensService } from "../src/modules/tokens/service";
import { createTestApp, createTestClock, insertUser, login, send, testIp } from "./support";

let testDb: TestDb;
let userId: string;
let projectId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  const user = await insertUser(testDb.db);
  userId = user.id;
  const [project] = await testDb.db
    .insert(projects)
    .values({ slug: `jobs-${randomUUID()}`, name: "Jobs", createdBy: userId })
    .returning();
  projectId = project?.id ?? "";
});

afterAll(async () => {
  await testDb.drop();
});

async function insertJob() {
  const [job] = await testDb.db
    .insert(jobs)
    .values({ type: "producer.chat", payload: {}, projectId, createdBy: userId })
    .returning();
  if (job === undefined) {
    throw new Error("job was not inserted");
  }
  return job;
}

describe("job tokens", () => {
  it("are bound to one job and project, carry the access scopes and expire", async () => {
    const clock = createTestClock();
    const tokens = createTokensService({ db: testDb.db, clock });
    const job = await insertJob();

    const read = await tokens.mintJobToken({
      jobId: job.id,
      projectId,
      userId,
      access: "read",
      ttlMs: 60_000,
    });
    expect(read.secret).toMatch(JOB_TOKEN_RE);
    expect(read.row).toMatchObject({
      kind: "job",
      jobId: job.id,
      projectId,
      userId,
      scopes: ["mcp:read"],
      tokenHash: sha256Hex(read.secret),
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });
    expect(read.row.prefix).toBe(read.secret.slice(0, 15));

    const write = await tokens.mintJobToken({
      jobId: job.id,
      projectId,
      userId,
      access: "read_write",
      ttlMs: 60_000,
    });
    expect(write.row.scopes).toEqual(["mcp:read", "mcp:write"]);

    expect(await tokens.verify(read.secret, "job")).toMatchObject({
      id: read.row.id,
      kind: "job",
      scopes: ["mcp:read"],
      user: { id: userId },
      projectId,
      jobId: job.id,
    });
    expect(await tokens.verify(read.secret, ["mcp", "job"])).toMatchObject({ kind: "job" });
    expect(await tokens.verify(read.secret, "mcp")).toBeNull();

    clock.advance(60_000);
    expect(await tokens.verify(read.secret, "job")).toBeNull();
  });

  it("are revoked per job", async () => {
    const tokens = createTokensService({ db: testDb.db, clock: createTestClock() });
    const job = await insertJob();
    const other = await insertJob();
    const minted = await tokens.mintJobToken({
      jobId: job.id,
      projectId,
      userId,
      access: "read",
      ttlMs: 60_000,
    });
    const kept = await tokens.mintJobToken({
      jobId: other.id,
      projectId,
      userId,
      access: "read",
      ttlMs: 60_000,
    });

    expect(await tokens.revokeForJob(job.id)).toBe(1);
    expect(await tokens.revokeForJob(job.id)).toBe(0);
    expect(await tokens.verify(minted.secret, "job")).toBeNull();
    expect(await tokens.verify(kept.secret, "job")).not.toBeNull();
  });

  it("are only minted through mintJobToken", async () => {
    const tokens = createTokensService({ db: testDb.db, clock: createTestClock() });
    await expect(
      tokens.create({ userId, kind: "job", name: "Job", scopes: ["mcp:read"] }),
    ).rejects.toThrow(/mintJobToken/);
  });

  it("are left out of the user's token list", async () => {
    const { app, clock } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const job = await insertJob();
    await createTokensService({ db: testDb.db, clock }).mintJobToken({
      jobId: job.id,
      projectId,
      userId: user.id,
      access: "read",
      ttlMs: 60_000,
    });
    const { cookie } = await login(app, user.email, undefined, testIp(40));
    const created = await send(app, "POST", "/api/tokens", {
      cookie,
      body: { name: "Laptop", scopes: ["mcp:read"] },
    });
    expect(created.status).toBe(201);

    const response = await send(app, "GET", "/api/tokens", { cookie });
    const body = (await response.json()) as { items: { kind: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.kind).toBe("mcp");
    const rows = await testDb.db.select().from(apiTokens).where(eq(apiTokens.userId, user.id));
    expect(rows.map((row) => row.kind).sort()).toEqual(["job", "mcp"]);
  });

  it("are revoked when a queued job is cancelled", async () => {
    const clock = createTestClock();
    const tokens = createTokensService({ db: testDb.db, clock });
    const lifecycle = createJobLifecycle({ db: testDb.db, bus: createEventBus(), clock });
    const job = await insertJob();
    const minted = await tokens.mintJobToken({
      jobId: job.id,
      projectId,
      userId,
      access: "read",
      ttlMs: 60_000,
    });
    const result = await lifecycle.requestCancel(job.id);
    expect(result?.job.status).toBe("cancelled");
    expect(await tokens.verify(minted.secret, "job")).toBeNull();
  });
});

describe("log redaction", () => {
  it("keeps set-password links and job credentials out of log lines", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      destination: { write: (line: string) => void lines.push(line) },
    });
    const link = `https://app.example.test/set-password#token=${randomUUID()}`;
    const secret = `${TOKEN_PREFIXES.job}${randomUUID().replaceAll("-", "")}`;
    logger.info({ setPasswordUrl: link, response: { setPasswordUrl: link } }, "invited");
    logger.info({ payload: { credentials: { mcp: { endpoint: "/mcp", token: secret } } } }, "sent");
    const output = lines.join("\n");
    expect(output).not.toContain(link);
    expect(output).not.toContain(secret);
    expect(output).toContain("[redacted]");
  });
});
