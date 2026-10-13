import { createHash, randomBytes } from "node:crypto";
import { TOKEN_PREFIXES, TOKEN_SECRET_LENGTH, type TokenKind } from "@loomcast/contracts";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Random bytes as base64url, for opaque secrets such as session tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Hex sha256 of a UTF-8 string. Tokens and codes are stored only in this form. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Encodes bytes as base62, left-padded with `0` to `length` characters. */
export function base62(bytes: Uint8Array, length: number): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  let out = "";
  while (value > 0n) {
    out = BASE62.charAt(Number(value % 62n)) + out;
    value /= 62n;
  }
  if (out.length > length) {
    throw new Error(`Value does not fit in ${length} base62 characters`);
  }
  return out.padStart(length, "0");
}

/** Characters of the random part kept in `api_tokens.prefix`, so the UI can tell tokens apart. */
export const TOKEN_DISPLAY_CHARS = 8;

export interface GeneratedToken {
  /** The full secret, for example `lc_mcp_<43 base62 chars>`. Shown once and never stored. */
  secret: string;
  /** sha256 of the secret, stored in `api_tokens.token_hash`. */
  hash: string;
  /** The kind prefix plus the first characters of the secret, for example `lc_mcp_3fKq9ZtA`. */
  prefix: string;
}

/** Generates a prefixed bearer token of `kind` from 32 random bytes. */
export function generatePrefixedToken(kind: TokenKind): GeneratedToken {
  const kindPrefix = TOKEN_PREFIXES[kind];
  const secret = `${kindPrefix}${base62(randomBytes(32), TOKEN_SECRET_LENGTH)}`;
  return {
    secret,
    hash: sha256Hex(secret),
    prefix: secret.slice(0, kindPrefix.length + TOKEN_DISPLAY_CHARS),
  };
}
