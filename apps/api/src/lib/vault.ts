import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { JsonObject } from "@loomcast/contracts";
import {
  CHANNEL_SECRET_NONCE_BYTES,
  CHANNEL_SECRET_TAG_BYTES,
  type ChannelRow,
  channels,
  type Database,
} from "@loomcast/db";
import { asc, eq, isNotNull } from "drizzle-orm";
import { HttpError } from "./errors";

// The token vault: AES-256-GCM encryption of platform credentials at rest. Each value is sealed
// with a random 12-byte nonce and additional authenticated data naming the row it belongs to
// (`channel:<id>`), so a ciphertext copied to another row does not decrypt. The stored form is the
// ciphertext with the 16-byte tag appended, the nonce, and the version of the key that sealed it.

/** Length of an encryption key: AES-256. */
export const VAULT_KEY_BYTES = 32;

/** Length of the random nonce of every sealed value. */
export const VAULT_NONCE_BYTES = CHANNEL_SECRET_NONCE_BYTES;

/** Length of the GCM authentication tag appended to the ciphertext. */
export const VAULT_TAG_BYTES = CHANNEL_SECRET_TAG_BYTES;

const ALGORITHM = "aes-256-gcm";

/** The keys the vault knows: the current one seals, every one of them opens. */
export interface VaultKeyring {
  /** Version stored with every value the current key seals. At least 1. */
  keyVersion: number;
  key: Buffer;
  /** Earlier keys by version, kept during a rotation so older values still decrypt. */
  previousKeys: ReadonlyMap<number, Buffer>;
}

/** A sealed value, as stored in the `secret_*` and `key_version` columns. */
export interface SealedSecret {
  /** Ciphertext with the 16-byte GCM tag appended. */
  secretCiphertext: Buffer;
  /** The 12-byte nonce. */
  secretNonce: Buffer;
  keyVersion: number;
}

export type VaultErrorCode = "not_configured" | "unknown_key_version" | "decrypt_failed";

/** A value could not be sealed or opened. The message never contains key material or plaintext. */
export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export interface TokenVault {
  /** False when the server runs without `LOOMCAST_ENCRYPTION_KEY` (allowed outside production). */
  readonly configured: boolean;
  /** Version of the key new values are sealed with; null when not configured. */
  readonly keyVersion: number | null;
  /** True when a value sealed with key `version` can be opened. */
  hasKey(version: number): boolean;
  /** Seals `value` (JSON) with the current key and a fresh nonce, bound to `aad`. */
  encrypt(value: JsonObject, aad: string): SealedSecret;
  /**
   * Opens a sealed value. Throws `VaultError`: `unknown_key_version` when the key is not in the
   * keyring, `decrypt_failed` when the tag does not verify (wrong `aad`, wrong key or tampering).
   */
  decrypt(sealed: SealedSecret, aad: string): JsonObject;
}

/** Additional data that binds a channel's credentials to its row. */
export function channelAad(channelId: string): string {
  return `channel:${channelId}`;
}

/** The sealed credentials of a channel row, or null when it has none. */
export function sealedSecretOf(
  row: Pick<ChannelRow, "secretCiphertext" | "secretNonce" | "keyVersion">,
): SealedSecret | null {
  if (row.secretCiphertext === null || row.secretNonce === null || row.keyVersion === null) {
    return null;
  }
  return {
    secretCiphertext: row.secretCiphertext,
    secretNonce: row.secretNonce,
    keyVersion: row.keyVersion,
  };
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes a base64 key. Returns null unless it is canonical base64 of exactly 32 bytes, so a
 * truncated or mistyped key is refused at startup rather than at the first decrypt.
 */
export function decodeVaultKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!BASE64_RE.test(trimmed) || trimmed.length % 4 !== 0) {
    return null;
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== VAULT_KEY_BYTES || key.toString("base64") !== trimmed) {
    return null;
  }
  return key;
}

export interface PreviousKeysParseResult {
  keys: Map<number, Buffer>;
  /** Problems found, without the key values. */
  issues: string[];
}

/**
 * Parses `LOOMCAST_ENCRYPTION_KEYS_PREVIOUS`: `version:base64key` pairs separated by commas.
 * Versions are integers of at least 1 and must not repeat.
 */
export function parsePreviousVaultKeys(value: string): PreviousKeysParseResult {
  const keys = new Map<number, Buffer>();
  const issues: string[] = [];
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  entries.forEach((entry, index) => {
    const separator = entry.indexOf(":");
    const versionText = separator === -1 ? "" : entry.slice(0, separator).trim();
    const version = /^\d{1,9}$/.test(versionText) ? Number(versionText) : Number.NaN;
    if (!Number.isInteger(version) || version < 1) {
      issues.push(`entry ${index + 1}: expected version:key with a version of at least 1`);
      return;
    }
    const key = decodeVaultKey(entry.slice(separator + 1));
    if (key === null) {
      issues.push(`version ${version}: the key must be 32 bytes, base64 encoded`);
      return;
    }
    if (keys.has(version)) {
      issues.push(`version ${version}: listed more than once`);
      return;
    }
    keys.set(version, key);
  });
  return { keys, issues };
}

function vaultUnavailable(): HttpError {
  return new HttpError(
    503,
    "vault_unavailable",
    "Credential encryption is not configured on this server.",
  );
}

/** A vault without keys (no `LOOMCAST_ENCRYPTION_KEY` outside production): every call fails. */
export function createUnconfiguredVault(): TokenVault {
  return {
    configured: false,
    keyVersion: null,
    hasKey: () => false,
    encrypt() {
      throw vaultUnavailable();
    },
    decrypt() {
      throw vaultUnavailable();
    },
  };
}

export function createVault(keyring: VaultKeyring): TokenVault {
  if (keyring.key.length !== VAULT_KEY_BYTES) {
    throw new VaultError("not_configured", `The encryption key must be ${VAULT_KEY_BYTES} bytes`);
  }
  const keys = new Map<number, Buffer>(keyring.previousKeys);
  keys.set(keyring.keyVersion, keyring.key);
  for (const [version, key] of keys) {
    if (!Number.isInteger(version) || version < 1 || key.length !== VAULT_KEY_BYTES) {
      throw new VaultError("not_configured", `Key version ${version} is not a valid key`);
    }
  }

  return {
    configured: true,
    keyVersion: keyring.keyVersion,
    hasKey: (version) => keys.has(version),

    encrypt(value, aad) {
      const nonce = randomBytes(VAULT_NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, keyring.key, nonce, {
        authTagLength: VAULT_TAG_BYTES,
      });
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const body = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
        cipher.final(),
      ]);
      return {
        secretCiphertext: Buffer.concat([body, cipher.getAuthTag()]),
        secretNonce: nonce,
        keyVersion: keyring.keyVersion,
      };
    },

    decrypt(sealed, aad) {
      const key = keys.get(sealed.keyVersion);
      if (key === undefined) {
        throw new VaultError(
          "unknown_key_version",
          `No key with version ${sealed.keyVersion} is configured`,
        );
      }
      const { secretCiphertext, secretNonce } = sealed;
      if (secretNonce.length !== VAULT_NONCE_BYTES || secretCiphertext.length <= VAULT_TAG_BYTES) {
        throw new VaultError("decrypt_failed", "The sealed value is malformed");
      }
      const tagStart = secretCiphertext.length - VAULT_TAG_BYTES;
      try {
        const decipher = createDecipheriv(ALGORITHM, key, secretNonce, {
          authTagLength: VAULT_TAG_BYTES,
        });
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(secretCiphertext.subarray(tagStart));
        const plain = Buffer.concat([
          decipher.update(secretCiphertext.subarray(0, tagStart)),
          decipher.final(),
        ]);
        const value: unknown = JSON.parse(plain.toString("utf8"));
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("not an object");
        }
        return value as JsonObject;
      } catch {
        throw new VaultError("decrypt_failed", "The sealed value could not be decrypted");
      }
    },
  };
}

export interface VaultRotationResult {
  /** Rows with credentials that were read. */
  rows: number;
  /** Rows sealed again with the current key (all of them, unless `dryRun`). */
  reencrypted: number;
  /** Rows already sealed with the current key before the run. */
  alreadyCurrent: number;
  /** Rows per key version before the run. */
  byKeyVersion: Record<string, number>;
  dryRun: boolean;
}

/** Rows whose key version the keyring does not hold. Rotation refuses to start. */
export class UnknownKeyVersionError extends VaultError {
  constructor(readonly rows: { table: string; id: string; keyVersion: number }[]) {
    const versions = [...new Set(rows.map((row) => row.keyVersion))].sort((a, b) => a - b);
    super(
      "unknown_key_version",
      `${rows.length} row(s) are sealed with key version(s) ${versions.join(", ")}, which are not ` +
        "configured. Add them to LOOMCAST_ENCRYPTION_KEYS_PREVIOUS and run again.",
    );
    this.name = "UnknownKeyVersionError";
  }
}

/**
 * Seals every stored credential again with the current key, in one transaction: rows are locked,
 * each value is decrypted (with whichever key sealed it) and encrypted with a fresh nonce. Refuses
 * before writing anything when a row's key version is not in the keyring, and rolls everything back
 * when a value fails to decrypt. With `dryRun`, every value is still decrypted, but nothing is
 * written.
 *
 * Every table that stores sealed values must be covered here: today that is `channels`.
 */
export async function rotateVault(
  db: Database,
  vault: TokenVault,
  options: { dryRun?: boolean } = {},
): Promise<VaultRotationResult> {
  if (!vault.configured || vault.keyVersion === null) {
    throw new VaultError("not_configured", "LOOMCAST_ENCRYPTION_KEY is not set");
  }
  const current = vault.keyVersion;
  const dryRun = options.dryRun === true;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: channels.id,
        secretCiphertext: channels.secretCiphertext,
        secretNonce: channels.secretNonce,
        keyVersion: channels.keyVersion,
      })
      .from(channels)
      .where(isNotNull(channels.secretCiphertext))
      .orderBy(asc(channels.id))
      .for("update");

    const byKeyVersion: Record<string, number> = {};
    const unknown: { table: string; id: string; keyVersion: number }[] = [];
    const sealedRows: { id: string; sealed: SealedSecret }[] = [];
    for (const row of rows) {
      const sealed = sealedSecretOf(row);
      if (sealed === null) {
        continue;
      }
      byKeyVersion[String(sealed.keyVersion)] = (byKeyVersion[String(sealed.keyVersion)] ?? 0) + 1;
      if (!vault.hasKey(sealed.keyVersion)) {
        unknown.push({ table: "channels", id: row.id, keyVersion: sealed.keyVersion });
      }
      sealedRows.push({ id: row.id, sealed });
    }
    if (unknown.length > 0) {
      throw new UnknownKeyVersionError(unknown);
    }

    let reencrypted = 0;
    for (const { id, sealed } of sealedRows) {
      const aad = channelAad(id);
      const value = vault.decrypt(sealed, aad);
      if (dryRun) {
        continue;
      }
      await tx.update(channels).set(vault.encrypt(value, aad)).where(eq(channels.id, id));
      reencrypted += 1;
    }
    return {
      rows: sealedRows.length,
      reencrypted,
      alreadyCurrent: byKeyVersion[String(current)] ?? 0,
      byKeyVersion,
      dryRun,
    };
  });
}
