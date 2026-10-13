import { PassThrough, Readable } from "node:stream";
import { MCP_TOKEN_RE, PASSWORD_TOKEN_TTL_MS } from "@loomcast/contracts";
import { apiTokens, auditLog, passwordTokens, sessions, users } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliIo, type RunAdminOptions, runAdmin } from "../src/cli/admin";
import { sha256Hex } from "../src/lib/crypto";
import { verifyPassword } from "../src/lib/password";
import { APP_ORIGIN, createTestApp, login, send, testIp, testPassword } from "./support";

const OWNER_PASSWORD = testPassword("owner");
const ADMIN_PASSWORD = testPassword("admin");
const RESET_PASSWORD = testPassword("reset");
const OTHER_PASSWORD = testPassword("other");

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function collect(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString("utf8");
}

/** Runs the admin CLI against the test database with `input` piped to stdin. */
async function admin(
  args: string[],
  input = "",
  options: RunAdminOptions = { appOrigin: APP_ORIGIN },
): Promise<Run> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const io: CliIo = { stdin: Readable.from([input]), stdout, stderr };
  const code = await runAdmin(args, io, () => ({ db: testDb.db, close: async () => {} }), options);
  return { code, stdout: out(), stderr: err() };
}

describe("admin create", () => {
  it("refuses an admin before the owner exists", async () => {
    const run = await admin(
      ["create", "--email", "early@example.test", "--name", "Early", "--role", "admin"],
      `${testPassword("first")}\n`,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Create the owner first");
    expect(await testDb.db.select().from(users)).toHaveLength(0);
  });

  it("creates the owner from a password on stdin", async () => {
    const run = await admin(
      [
        "create",
        "--email",
        "Owner@Example.test",
        "--name",
        "Owner",
        "--role",
        "owner",
        "--password-stdin",
      ],
      `${OWNER_PASSWORD}\n`,
    );
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^Created owner owner@example\.test \(/);

    const [owner] = await testDb.db
      .select()
      .from(users)
      .where(eq(users.email, "owner@example.test"));
    expect(owner).toMatchObject({ name: "Owner", role: "owner", disabledAt: null });
    expect(owner?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(owner?.passwordHash ?? "", OWNER_PASSWORD)).toBe(true);

    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, owner?.id ?? ""));
    expect(audits.map((row) => row.action)).toEqual(["user.created"]);

    // The new owner can sign in.
    const { app } = createTestApp(testDb.db);
    await login(app, "owner@example.test", OWNER_PASSWORD);
  });

  it("refuses a second owner and duplicate emails", async () => {
    const second = await admin(
      ["create", "--email", "other@example.test", "--name", "Other", "--role", "owner"],
      `${OTHER_PASSWORD}\n`,
    );
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("An owner already exists");

    const duplicate = await admin(
      ["create", "--email", "OWNER@example.test", "--name", "Dup", "--role", "admin"],
      `${OTHER_PASSWORD}\n`,
    );
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already exists");
  });

  it("creates an admin once the owner exists", async () => {
    const run = await admin(
      ["create", "--email", "admin@example.test", "--name", "Admin", "--role", "admin"],
      `${ADMIN_PASSWORD}\r\nignored second line\n`,
    );
    expect(run.code).toBe(0);
    const [created] = await testDb.db
      .select()
      .from(users)
      .where(eq(users.email, "admin@example.test"));
    expect(await verifyPassword(created?.passwordHash ?? "", ADMIN_PASSWORD)).toBe(true);
  });

  it("rejects short passwords and bad arguments", async () => {
    const short = await admin(
      ["create", "--email", "short@example.test", "--name", "S", "--role", "admin"],
      "short\n",
    );
    expect(short.code).toBe(1);
    expect(short.stderr).toContain("Password");

    const role = await admin(
      ["create", "--email", "r@example.test", "--name", "R", "--role", "root"],
      `${testPassword("long")}\n`,
    );
    expect(role.code).toBe(2);

    const missing = await admin(["create", "--name", "No email", "--role", "admin"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Missing --email");

    const unknown = await admin(["create", "--emial", "x@example.test"]);
    expect(unknown.code).toBe(2);

    const help = await admin([]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage:");
  });
});

describe("admin token", () => {
  it("prints an MCP token once and stores only its hash", async () => {
    const run = await admin([
      "token",
      "--email",
      "owner@example.test",
      "--name",
      "Laptop",
      "--scopes",
      "mcp:read, mcp:write,mcp:admin",
    ]);
    expect(run.code).toBe(0);
    const secret = run.stdout.trim();
    expect(secret).toMatch(MCP_TOKEN_RE);
    expect(run.stderr).toContain("cannot be shown again");
    expect(run.stderr).not.toContain(secret);

    const [row] = await testDb.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, sha256Hex(secret)));
    expect(row).toMatchObject({ kind: "mcp", name: "Laptop" });
    expect(row?.scopes).toEqual(["mcp:read", "mcp:write", "mcp:admin"]);
  });

  it("refuses mcp:admin for an admin, unknown scopes and unknown accounts", async () => {
    const adminScope = await admin([
      "token",
      "--email",
      "admin@example.test",
      "--name",
      "x",
      "--scopes",
      "mcp:admin",
    ]);
    expect(adminScope.code).toBe(1);
    expect(adminScope.stderr).toContain("Only the owner");

    const badScope = await admin([
      "token",
      "--email",
      "admin@example.test",
      "--name",
      "x",
      "--scopes",
      "bridge",
    ]);
    expect(badScope.code).toBe(1);

    const nobody = await admin([
      "token",
      "--email",
      "nobody@example.test",
      "--name",
      "x",
      "--scopes",
      "mcp:read",
    ]);
    expect(nobody.code).toBe(1);
    expect(nobody.stderr).toContain("No account");
  });
});

describe("admin reset-password", () => {
  it("sets the new password and ends every session", async () => {
    const { app } = createTestApp(testDb.db);
    const { cookie } = await login(app, "admin@example.test", ADMIN_PASSWORD);

    const run = await admin(
      ["reset-password", "--email", "admin@example.test"],
      `${RESET_PASSWORD}\n`,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Ended 1 session(s)");

    expect((await send(app, "GET", "/api/auth/me", { cookie })).status).toBe(401);
    const [user] = await testDb.db
      .select()
      .from(users)
      .where(eq(users.email, "admin@example.test"));
    const left = await testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user?.id ?? ""));
    expect(left).toHaveLength(0);
    await login(app, "admin@example.test", RESET_PASSWORD, testIp(77));
  });
});

describe("admin create --invite", () => {
  it("prints a one-time set-password link instead of asking for a password", async () => {
    const started = Date.now();
    const run = await admin([
      "create",
      "--email",
      "Invited@Example.test",
      "--name",
      "Invited",
      "--role",
      "admin",
      "--invite",
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("Invited admin invited@example.test");
    expect(run.stderr).toContain("cannot be shown again");
    const link = run.stdout.trim();
    expect(link.startsWith(`${APP_ORIGIN}/set-password#token=`)).toBe(true);
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token") ?? "";
    expect(run.stderr).not.toContain(token);

    const [user] = await testDb.db
      .select()
      .from(users)
      .where(eq(users.email, "invited@example.test"));
    expect(user).toMatchObject({ role: "admin", passwordHash: null });
    const [row] = await testDb.db
      .select()
      .from(passwordTokens)
      .where(eq(passwordTokens.userId, user?.id ?? ""));
    expect(row).toMatchObject({
      tokenHash: sha256Hex(token),
      purpose: "invite",
      createdBy: null,
    });
    expect(row?.expiresAt.getTime()).toBeGreaterThanOrEqual(started + PASSWORD_TOKEN_TTL_MS.invite);
    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, user?.id ?? ""));
    expect(audits.map((entry) => entry.action)).toEqual(["user.invited"]);

    // The link works in the app.
    const { app } = createTestApp(testDb.db);
    const chosen = testPassword("invited");
    const set = await send(app, "POST", "/api/auth/set-password", {
      body: { token, newPassword: chosen },
      ip: testIp(91),
    });
    expect(set.status).toBe(204);
    await login(app, "invited@example.test", chosen, testIp(92));
  });

  it("needs APP_ORIGIN and refuses --invite with a password or on other commands", async () => {
    const noOrigin = await admin(
      ["create", "--email", "o@example.test", "--name", "O", "--role", "admin", "--invite"],
      "",
      { appOrigin: "" },
    );
    expect(noOrigin.code).toBe(1);
    expect(noOrigin.stderr).toContain("APP_ORIGIN");

    const both = await admin([
      "create",
      "--email",
      "b@example.test",
      "--name",
      "B",
      "--role",
      "admin",
      "--invite",
      "--password-stdin",
    ]);
    expect(both.code).toBe(2);

    const token = await admin([
      "token",
      "--email",
      "owner@example.test",
      "--name",
      "x",
      "--scopes",
      "mcp:read",
      "--invite",
    ]);
    expect(token.code).toBe(2);
    const left = await testDb.db.select().from(users).where(eq(users.email, "o@example.test"));
    expect(left).toHaveLength(0);
  });
});
