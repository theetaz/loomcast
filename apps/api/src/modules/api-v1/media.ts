import type { Readable } from "node:stream";
import type { Storage } from "../../lib/storage";

// The first bytes of an uploaded file, checked against the MIME type the API client declared.
// The store only checks size and checksum, and the signed `Content-Type` is whatever the client
// said, so a file is published only when its leading bytes are those of its declared type.

/** Bytes read from the start of a stored file. */
export const SNIFF_BYTES = 16;

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * The MIME type the leading bytes show: JPEG, PNG and WebP photos, and ISO base media videos (an
 * `ftyp` box; `qt  ` as its brand, or an old QuickTime atom, means QuickTime). Null otherwise.
 */
export function sniffMediaMime(head: Uint8Array): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length >= png.length && png.every((byte, index) => head[index] === byte)) {
    return "image/png";
  }
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (head.length >= 12) {
    const box = ascii(head, 4, 8);
    if (box === "ftyp") {
      return ascii(head, 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
    }
    if (["moov", "mdat", "wide", "free", "skip"].includes(box)) {
      return "video/quicktime";
    }
  }
  return null;
}

/**
 * Whether bytes that look like `sniffed` may be published as `declared`. Photos must match
 * exactly; MP4 and QuickTime share a container, so either counts as either.
 */
export function mimeMatches(declared: string, sniffed: string | null): boolean {
  if (sniffed === null) {
    return false;
  }
  if (declared.startsWith("video/")) {
    return sniffed.startsWith("video/");
  }
  return declared === sniffed;
}

/** The first `bytes` bytes of a stored object. Throws when there is no such object. */
export async function readHead(storage: Storage, key: string, bytes = SNIFF_BYTES) {
  const stream: Readable = await storage.getStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buffer);
      total += buffer.length;
      if (total >= bytes) break;
    }
  } finally {
    stream.destroy();
  }
  return new Uint8Array(Buffer.concat(chunks).subarray(0, bytes));
}
