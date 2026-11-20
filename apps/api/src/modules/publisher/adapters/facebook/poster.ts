import { type FetchLike, type GraphFile, META_GRAPH_TIMEOUT_MS } from "../../../../lib/meta-graph";

// Reading a Reel's poster for its cover. The Video Thumbnails edge takes the image as a file, not
// a link, so the adapter reads the poster's public copy (the link Instagram gets as `cover_url`)
// and uploads its bytes. Posters are small (the studio renders a JPEG frame), so the bytes are held
// in memory, up to one byte past the platform's limit: a larger poster is reported by its size and
// never read in full.

/** The poster as read: its bytes (when within `maxBytes`), its size and its type. */
export interface PosterRead {
  /** The image, ready for the multipart upload; null when the poster is larger than `maxBytes`. */
  file: GraphFile | null;
  /** The poster's size in bytes; above `maxBytes` when it is too large. */
  size: number;
  /** The type its first bytes show, else its `Content-Type`. */
  mime: string;
}

/** Why the poster could not be read. Its message names no URL. */
export class PosterReadError extends Error {
  override readonly name = "PosterReadError";
}

/** The image type the first bytes of a file show; null when they show none of these. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0xff, 0xd8, 0xff)) {
    return "image/jpeg";
  }
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return "image/png";
  }
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    return "image/webp";
  }
  if (starts(0x47, 0x49, 0x46, 0x38)) {
    return "image/gif";
  }
  return null;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Reads `body` until it ends or `limit` bytes came, then stops reading. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let filled = 0;
  if (body !== null) {
    const reader = body.getReader();
    try {
      while (filled < limit) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = value.subarray(0, limit - filled);
        chunks.push(chunk);
        filled += chunk.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const out = new Uint8Array(filled);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Reads the poster at `url`: no redirects, the Graph client's timeout, at most `maxBytes + 1`
 * bytes. Throws `PosterReadError` when it cannot be read, or the caller's abort reason.
 */
export async function readPoster(
  url: string,
  options: { maxBytes: number; signal: AbortSignal; fetch?: FetchLike; timeoutMs?: number },
): Promise<PosterRead> {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeout = AbortSignal.timeout(options.timeoutMs ?? META_GRAPH_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeout]);
  try {
    const response = await doFetch(url, { method: "GET", redirect: "error", signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new PosterReadError(`The poster could not be read (HTTP ${response.status}).`);
    }
    const header = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await response.body?.cancel().catch(() => {});
      return { file: null, size: declared, mime: header || "application/octet-stream" };
    }
    const bytes = await readCapped(response.body, options.maxBytes + 1);
    if (bytes.length === 0) {
      throw new PosterReadError("The poster is empty.");
    }
    const mime = sniffImageType(bytes) ?? (header || "application/octet-stream");
    return {
      file:
        bytes.length > options.maxBytes
          ? null
          : { bytes, type: mime, filename: `poster.${EXTENSIONS[mime] ?? "bin"}` },
      size: bytes.length,
      mime,
    };
  } catch (error) {
    if (options.signal.aborted) {
      throw options.signal.reason ?? error;
    }
    if (error instanceof PosterReadError) {
      throw error;
    }
    throw new PosterReadError(
      timeout.aborted ? "The poster did not load in time." : "The poster could not be read.",
    );
  }
}
