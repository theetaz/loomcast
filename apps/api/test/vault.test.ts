import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { type ChannelRow, channels } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runVault } from "../src/cli/vault";
import type { ModuleDeps } from "../src/deps";
import { ConfigError, parseConfig } from "../src/env";
import { HttpError } from "../src/lib/errors";
import { createLogger } from "../src/lib/logger";
import {
  channelAad,
  createUnconfiguredVault,
  createVault,
  decodeVaultKey,
  rotateVault,
  sealedSecretOf,
  type TokenVault,
  UnknownKeyVersionError,
  VAULT_NONCE_BYTES,
  VAULT_TAG_BYTES,
  VaultError,
  type VaultKeyring,
} from "../src/lib/vault";
import { createTestApp, defaultWorkspace, testPassword } from "./support";

/** A fresh 32-byte key per call; no key material lives in the suite. */
function newKey(): Buffer {
  return randomBytes(32);
}

function keyring(keyVersion: number, key: Buffer, previous: [number, Buffer][] = []): VaultKeyring {
  return { keyVersion, key, previousKeys: new Map(previous) };
}

function credentials() {
  return { accessToken: testPassword("access"), pageId: randomUUID() };
}

describe("vault", () => {
  it("round-trips a value bound to its channel", () => {
    const vault = createVault(keyring(1, newKey()));
    const channelId = randomUUID();
    const value = credentials();
    const sealed = vault.encrypt(value, channelAad(channelId));
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.secretNonce).toHaveLength(VAULT_NONCE_BYTES);
    expect(sealed.secretCiphertext.length).toBeGreaterThan(VAULT_TAG_BYTES);
    expect(sealed.secretCiphertext.toString("utf8")).not.toContain(value.accessToken);
    expect(vault.decrypt(sealed, channelAad(channelId))).toEqual(value);
  });

  it("uses a fresh nonce for every value", () => {
    const vault = createVault(keyring(1, newKey()));
    const aad = channelAad(randomUUID());
    const value = credentials();
    const first = vault.encrypt(value, aad);
    const second = vault.encrypt(value, aad);
    expect(first.secretNonce.equals(second.secretNonce)).toBe(false);
    expect(first.secretCiphertext.equals(second.secretCiphertext)).toBe(false);
  });

  it("refuses a value opened with the wrong additional data, key or bytes", () => {
    const key = newKey();
    const vault = createVault(keyring(1, key));
    const sealed = vault.encrypt(credentials(), channelAad(randomUUID()));
    const failure = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        expect(error).toBeInstanceOf(VaultError);
        return (error as VaultError).code;
      }
      return "no error";
    };
    expect(failure(() => vault.decrypt(sealed, channelAad(randomUUID())))).toBe("decrypt_failed");
    expect(failure(() => createVault(keyring(1, newKey())).decrypt(sealed, "x"))).toBe(
      "decrypt_failed",
    );
    const tampered = Buffer.from(sealed.secretCiphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(failure(() => vault.decrypt({ ...sealed, secretCiphertext: tampered }, "x"))).toBe(
      "decrypt_failed",
    );
    expect(failure(() => vault.decrypt({ ...sealed, keyVersion: 7 }, "x"))).toBe(
      "unknown_key_version",
    );
  });

  it("opens values sealed with a previous key and seals with the current one", () => {
    const oldKey = newKey();
    const aad = channelAad(randomUUID());
    const value = credentials();
    const sealedV1 = createVault(keyring(1, oldKey)).encrypt(value, aad);
    const vault = createVault(keyring(2, newKey(), [[1, oldKey]]));
    expect(vault.decrypt(sealedV1, aad)).toEqual(value);
    expect(vault.encrypt(value, aad).keyVersion).toBe(2);
    expect(vault.hasKey(1) && vault.hasKey(2) && !vault.hasKey(3)).toBe(true);
  });

  it("answers 503 without a key", () => {
    const vault = createUnconfiguredVault();
    expect(vault.configured).toBe(false);
    expect(() => vault.encrypt({}, "x")).toThrow(HttpError);
    try {
      vault.encrypt({}, "x");
    } catch (error) {
      expect((error as HttpError).status).toBe(503);
      expect((error as HttpError).code).toBe("vault_unavailable");
    }
  });

  it("accepts only canonical base64 of 32 bytes", () => {
    const key = newKey();
    expect(decodeVaultKey(key.toString("base64"))?.equals(key)).toBe(true);
    expect(decodeVaultKey(randomBytes(16).toString("base64"))).toBeNull();
    expect(decodeVaultKey(randomBytes(33).toString("base64"))).toBeNull();
    expect(decodeVaultKey(key.toString("hex"))).toBeNull();
    expect(decodeVaultKey("")).toBeNull();
  });
});

describe("vault config", () => {
  const base = {
    DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
    APP_ORIGIN: "http://localhost:5173",
    PUBLIC_BASE_URL: "https://media.example.com",
  };

  function issues(env: Record<string, string>): string[] {
    try {
      parseConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).issues;
    }
    return [];
  }

  it("is optional outside production and defaults the scheduler and publishing settings", () => {
    const config = parseConfig(base);
    expect(config.encryption).toBeNull();
    expect(config.scheduler).toEqual({ enabled: true, tickMs: 5_000 });
    expect(config.publishing).toEqual({ mode: "dry-run", enabled: true });
    expect(config.cadenceHorizonDays).toBe(14);
    expect(parseConfig({ ...base, LOOMCAST_ENCRYPTION_KEY: "" }).encryption).toBeNull();
  });

  it("reads the keyring and the other new settings", () => {
    const current = newKey();
    const previous = newKey();
    const config = parseConfig({
      ...base,
      LOOMCAST_ENCRYPTION_KEY: current.toString("base64"),
      LOOMCAST_ENCRYPTION_KEY_VERSION: "3",
      LOOMCAST_ENCRYPTION_KEYS_PREVIOUS: ` 2:${previous.toString("base64")} `,
      SCHEDULER_ENABLED: "false",
      SCHEDULER_TICK_MS: "1000",
      PUBLISHING_MODE: "live",
      PUBLISHING_ENABLED: "false",
      CADENCE_HORIZON_DAYS: "21",
    });
    expect(config.encryption?.keyVersion).toBe(3);
    expect(config.encryption?.key.equals(current)).toBe(true);
    expect(config.encryption?.previousKeys.get(2)?.equals(previous)).toBe(true);
    expect(config.scheduler).toEqual({ enabled: false, tickMs: 1_000 });
    expect(config.publishing).toEqual({ mode: "live", enabled: false });
    expect(config.cadenceHorizonDays).toBe(21);
  });

  it("rejects a bad key length, a missing production key and bad previous keys", () => {
    const short = randomBytes(31).toString("base64");
    const shortIssues = issues({ ...base, LOOMCAST_ENCRYPTION_KEY: short });
    expect(shortIssues).toHaveLength(1);
    expect(shortIssues[0]).toMatch(/^LOOMCAST_ENCRYPTION_KEY: Must be 32 random bytes/);
    // The message never repeats the value.
    expect(shortIssues.join("\n")).not.toContain(short);

    expect(
      issues({
        ...base,
        NODE_ENV: "production",
        S3_ENDPOINT: "http://127.0.0.1:59000",
        S3_ACCESS_KEY: testPassword("access"),
        S3_SECRET_KEY: testPassword("secret"),
      }).map((issue) => issue.split(":")[0]),
    ).toEqual(["LOOMCAST_ENCRYPTION_KEY"]);

    const current = newKey().toString("base64");
    const previous = newKey().toString("base64");
    const bad = issues({
      ...base,
      LOOMCAST_ENCRYPTION_KEY: current,
      LOOMCAST_ENCRYPTION_KEYS_PREVIOUS: `1:${previous},x:${previous},2:short`,
    });
    expect(bad.every((issue) => issue.startsWith("LOOMCAST_ENCRYPTION_KEYS_PREVIOUS"))).toBe(true);
    expect(bad).toHaveLength(3);
    expect(bad.join("\n")).not.toContain(previous);
    expect(
      issues({ ...base, LOOMCAST_ENCRYPTION_KEYS_PREVIOUS: `1:${previous}` }).map(
        (issue) => issue.split(":")[0],
      ),
    ).toEqual(["LOOMCAST_ENCRYPTION_KEYS_PREVIOUS"]);
    expect(issues({ ...base, PUBLISHING_MODE: "Live" })[0]).toMatch(/^PUBLISHING_MODE/);
  });

  it("never logs the keyring", () => {
    const key = newKey();
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      destination: { write: (line) => void lines.push(line) },
    });
    const config = parseConfig({ ...base, LOOMCAST_ENCRYPTION_KEY: key.toString("base64") });
    logger.info({ config, env: { LOOMCAST_ENCRYPTION_KEY: key.toString("base64") } }, "config");
    const output = lines.join("");
    expect(output).not.toContain(key.toString("base64"));
    expect(output).not.toContain(key.toString("hex"));
    expect(output).toContain("[redacted]");
  });
});

describe("vault in the app", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.db.delete(channels);
  });

  async function insertChannel(vault: TokenVault, value = credentials()): Promise<ChannelRow> {
    const id = randomUUID();
    const [row] = await testDb.db
      .insert(channels)
      .values({
        id,
        workspaceId: await defaultWorkspace(testDb.db),
        platform: "instagram",
        displayName: `Channel ${id.slice(0, 8)}`,
        status: "active",
        ...vault.encrypt(value, channelAad(id)),
      })
      .returning();
    if (row === undefined) throw new Error("channel not inserted");
    return row;
  }

  async function channelRow(id: string): Promise<ChannelRow> {
    const [row] = await testDb.db.select().from(channels).where(eq(channels.id, id));
    if (row === undefined) throw new Error("channel not found");
    return row;
  }

  function open(vault: TokenVault, row: ChannelRow) {
    const sealed = sealedSecretOf(row);
    if (sealed === null) throw new Error("no secret");
    return vault.decrypt(sealed, channelAad(row.id));
  }

  it("is shared with modules, configured from the keyring", () => {
    let deps: ModuleDeps | undefined;
    createTestApp(testDb.db, {
      config: { encryption: keyring(4, newKey()) },
      modules: [
        (app, registered) => {
          deps = registered;
          return app;
        },
      ],
    });
    expect(deps?.vault.configured).toBe(true);
    expect(deps?.vault.keyVersion).toBe(4);

    createTestApp(testDb.db, {
      modules: [
        (app, registered) => {
          deps = registered;
          return app;
        },
      ],
    });
    expect(deps?.vault.configured).toBe(false);
  });

  it("rotates every row to the current key in one transaction", async () => {
    const oldKey = newKey();
    const v1 = createVault(keyring(1, oldKey));
    const values = [credentials(), credentials(), credentials()];
    const rows = [];
    for (const value of values) {
      rows.push(await insertChannel(v1, value));
    }
    const v2 = createVault(keyring(2, newKey(), [[1, oldKey]]));
    const current = await insertChannel(v2);
    const empty = await testDb.db
      .insert(channels)
      .values({
        workspaceId: await defaultWorkspace(testDb.db),
        platform: "threads",
        displayName: "Disconnected",
      })
      .returning();

    const dry = await rotateVault(testDb.db, v2, { dryRun: true });
    expect(dry).toEqual({
      rows: 4,
      reencrypted: 0,
      alreadyCurrent: 1,
      byKeyVersion: { "1": 3, "2": 1 },
      dryRun: true,
    });
    expect((await channelRow(rows[0]?.id ?? "")).keyVersion).toBe(1);

    const result = await rotateVault(testDb.db, v2);
    expect(result).toMatchObject({ rows: 4, reencrypted: 4, dryRun: false });
    for (const [index, row] of rows.entries()) {
      const after = await channelRow(row.id);
      expect(after.keyVersion).toBe(2);
      expect(after.secretNonce?.equals(row.secretNonce ?? Buffer.alloc(0))).toBe(false);
      expect(open(v2, after)).toEqual(values[index]);
      // The old key alone no longer opens it.
      expect(() => open(v1, after)).toThrow(VaultError);
    }
    expect((await channelRow(current.id)).keyVersion).toBe(2);
    expect((await channelRow(empty[0]?.id ?? "")).secretCiphertext).toBeNull();
  });

  it("refuses to rotate when a row's key version is unknown, and changes nothing", async () => {
    const keyOne = newKey();
    const keyTwo = newKey();
    const known = await insertChannel(createVault(keyring(1, keyOne)));
    const unknown = await insertChannel(createVault(keyring(2, keyTwo)));
    const vault = createVault(keyring(3, newKey(), [[1, keyOne]]));

    await expect(rotateVault(testDb.db, vault)).rejects.toBeInstanceOf(UnknownKeyVersionError);
    await expect(rotateVault(testDb.db, vault, { dryRun: true })).rejects.toThrow(
      /key version\(s\) 2/,
    );
    expect((await channelRow(known.id)).keyVersion).toBe(1);
    expect((await channelRow(unknown.id)).keyVersion).toBe(2);
  });

  it("rolls back when a value does not decrypt", async () => {
    const key = newKey();
    const vault = createVault(keyring(1, key));
    const good = await insertChannel(vault);
    const moved = await insertChannel(vault);
    // A ciphertext copied from another row fails its additional data check.
    await testDb.db
      .update(channels)
      .set({ secretCiphertext: good.secretCiphertext, secretNonce: good.secretNonce })
      .where(eq(channels.id, moved.id));
    const next = createVault(keyring(2, newKey(), [[1, key]]));
    await expect(rotateVault(testDb.db, next)).rejects.toMatchObject({ code: "decrypt_failed" });
    expect((await channelRow(good.id)).keyVersion).toBe(1);
  });

  describe("vault CLI", () => {
    async function cli(args: string[], env: Record<string, string | undefined>) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      stdout.on("data", (chunk: Buffer) => out.push(chunk));
      stderr.on("data", (chunk: Buffer) => err.push(chunk));
      const code = await runVault(args, { stdout, stderr }, env, () => ({
        db: testDb.db,
        close: async () => {},
      }));
      return {
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      };
    }

    it("rotates, with a dry run first, and never prints keys", async () => {
      const oldKey = newKey();
      const row = await insertChannel(createVault(keyring(1, oldKey)));
      const newKeyValue = newKey();
      const env = {
        DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
        LOOMCAST_ENCRYPTION_KEY: newKeyValue.toString("base64"),
        LOOMCAST_ENCRYPTION_KEY_VERSION: "2",
        LOOMCAST_ENCRYPTION_KEYS_PREVIOUS: `1:${oldKey.toString("base64")}`,
      };

      const dry = await cli(["rotate", "--", "--dry-run"], env);
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain("Dry run: 1 sealed value(s) found (v1: 1)");
      expect((await channelRow(row.id)).keyVersion).toBe(1);

      const run = await cli(["rotate"], env);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("Sealed 1 value(s) again with key version 2");
      expect((await channelRow(row.id)).keyVersion).toBe(2);

      for (const output of [dry.stdout, dry.stderr, run.stdout, run.stderr]) {
        expect(output).not.toContain(newKeyValue.toString("base64"));
        expect(output).not.toContain(oldKey.toString("base64"));
      }
    });

    it("refuses unknown versions, missing or bad keys and bad usage", async () => {
      await insertChannel(createVault(keyring(5, newKey())));
      const env = {
        DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
        LOOMCAST_ENCRYPTION_KEY: newKey().toString("base64"),
      };
      const unknown = await cli(["rotate", "--dry-run"], env);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toMatch(/key version\(s\) 5/);

      const missing = await cli(["rotate"], { DATABASE_URL: env.DATABASE_URL });
      expect(missing).toMatchObject({ code: 1, stderr: "LOOMCAST_ENCRYPTION_KEY is not set.\n" });

      const short = randomBytes(8).toString("base64");
      const bad = await cli(["rotate"], { ...env, LOOMCAST_ENCRYPTION_KEY: short });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("LOOMCAST_ENCRYPTION_KEY: Must be 32 random bytes");
      expect(bad.stderr).not.toContain(short);

      expect((await cli(["spin"], env)).code).toBe(2);
      expect((await cli(["rotate", "--force"], env)).code).toBe(2);
      expect((await cli([], env)).stdout).toContain("vault rotate [--dry-run]");
    });
  });
});
