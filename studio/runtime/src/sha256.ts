import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Streams a file through SHA-256 without loading it into memory. */
export async function sha256File(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    sizeBytes += bytes.length;
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

/** SHA-256 of bytes or UTF-8 text, as lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
