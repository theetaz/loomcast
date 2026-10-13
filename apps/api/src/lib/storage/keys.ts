import { randomBytes } from "node:crypto";
import type { AssetKind, AssetMimeType } from "@loomcast/contracts";

/** File extension stored in object keys, per asset MIME type. */
export const MIME_EXTENSIONS: { readonly [M in AssetMimeType]: string } = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "text/plain": "txt",
};

/** The extension for `mime`, or `bin` for a type outside the asset allow-list. */
export function extensionForMime(mime: string): string {
  return (MIME_EXTENSIONS as Readonly<Record<string, string>>)[mime] ?? "bin";
}

/** Who holds an asset: a content item of a project, or the project itself (`itemId` null). */
export interface AssetOwner {
  projectId: string;
  itemId?: string | null;
}

/**
 * Private key of an asset, content-addressed within its owner, as uploads are deduplicated:
 * `projects/<projectId>/items/<itemId>/<kind>/<sha256>.<ext>` for an item's asset and
 * `projects/<projectId>/media/<kind>/<sha256>.<ext>` for project-level media such as references.
 * Two items holding the same bytes get one object each, so deleting one asset's object never
 * removes another's. Assets stored before uploads were deduplicated per item keep their keys
 * (`projects/<projectId>/<kind>/<sha256>.<ext>`); no kind is named `items` or `media`, so a new
 * key never lands on one of those objects.
 */
export function assetStorageKey(
  owner: AssetOwner,
  kind: AssetKind,
  sha256: string,
  mime: string,
): string {
  const scope =
    owner.itemId === undefined || owner.itemId === null ? "media" : `items/${owner.itemId}`;
  return `projects/${owner.projectId}/${scope}/${kind}/${sha256.toLowerCase()}.${extensionForMime(mime)}`;
}

const SHA256_FILE_RE = /(?:^|\/)([0-9a-f]{64})(?:\.([a-z0-9]{1,8}))?$/;

/** The SHA-256 and extension a content-addressed key ends with, or null. */
export function parseContentKey(key: string): { sha256: string; ext: string | null } | null {
  const match = SHA256_FILE_RE.exec(key);
  if (match?.[1] === undefined) {
    return null;
  }
  return { sha256: match[1], ext: match[2] ?? null };
}

/** Public key of a promoted object: `p/<ulid>/<sha256>.<ext>`. The ULID makes it unguessable. */
export function publicObjectKey(sha256: string, ext: string, now: Date = new Date()): string {
  return `p/${ulid(now)}/${sha256.toLowerCase()}.${ext}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID: 48 bits of millisecond time and 80 random bits, as 26 Crockford base32 characters.
 * Sorts by creation time; the random part makes it unguessable.
 */
export function ulid(now: Date = new Date()): string {
  let time = now.getTime();
  let timePart = "";
  for (let i = 0; i < 10; i += 1) {
    timePart = CROCKFORD.charAt(time % 32) + timePart;
    time = Math.floor(time / 32);
  }
  const random = randomBytes(10);
  let bits = 0n;
  for (const byte of random) {
    bits = (bits << 8n) | BigInt(byte);
  }
  let randomPart = "";
  for (let i = 0; i < 16; i += 1) {
    randomPart = CROCKFORD.charAt(Number(bits & 31n)) + randomPart;
    bits >>= 5n;
  }
  return timePart + randomPart;
}

/**
 * A `Content-Disposition` value that survives any file name: an ASCII fallback in `filename` and
 * the exact name, percent-encoded, in `filename*` (RFC 6266).
 */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Hex SHA-256 as the base64 value S3 checksum headers carry. */
export function sha256HexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

/** A base64 S3 checksum as lowercase hex, or null when it is not a whole-object SHA-256. */
export function sha256Base64ToHex(value: string | undefined | null): string | null {
  if (value === undefined || value === null || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return null;
  }
  return Buffer.from(value, "base64").toString("hex");
}
