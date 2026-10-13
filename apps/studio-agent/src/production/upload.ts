import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  Asset,
  AssetKind,
  AssetMimeType,
  AssetProbe,
  UploadInstructions,
  VoiceAlignment,
} from "@loomcast/contracts";
import type { MediaProbe } from "@loomcast/studio/runtime";
import type { FetchLike, Sleep } from "./context";
import { type PlatformClient, PlatformError } from "./platform";

export type { FetchLike, Sleep } from "./context";

/** A failed upload or download. */
export class TransferError extends Error {
  override readonly name = "TransferError";
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

/** Streams a file through SHA-256; the file is never held in memory. */
export async function sha256OfFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** The media facts of a probe, in the shape the server stores when an asset is finalized. */
export function assetProbe(probe: MediaProbe): AssetProbe {
  const result: AssetProbe = { formatName: probe.formatName.slice(0, 128) };
  if (Number.isFinite(probe.durationMs) && probe.durationMs >= 0) {
    result.durationMs = Math.round(probe.durationMs);
  }
  if (probe.video !== undefined) {
    if (probe.video.width > 0) result.width = probe.video.width;
    if (probe.video.height > 0) result.height = probe.video.height;
    if (probe.video.fps >= 0 && probe.video.fps <= 1_000) result.fps = probe.video.fps;
    result.videoCodec = probe.video.codec.slice(0, 64);
  }
  if (probe.audio !== undefined) {
    result.audioCodec = probe.audio.codec.slice(0, 64);
    if (probe.audio.sampleRate > 0) result.sampleRate = probe.audio.sampleRate;
    if (probe.audio.channels > 0 && probe.audio.channels <= 64) {
      result.channels = probe.audio.channels;
    }
    if (probe.audio.bitRate !== undefined && probe.audio.bitRate > 0) {
      result.bitRate = Math.round(probe.audio.bitRate);
    }
  }
  return result;
}

export interface UploadFileOptions {
  readonly platform: PlatformClient;
  readonly itemId: string;
  readonly kind: AssetKind;
  readonly path: string;
  readonly mime: AssetMimeType;
  /** The download name; defaults to the file's own name. */
  readonly filename?: string;
  readonly probe?: AssetProbe;
  /** A voice take's word timings, stored with the asset. */
  readonly alignment?: VoiceAlignment;
  readonly signal: AbortSignal;
  /** PUT attempts, including the first. Defaults to 3. */
  readonly attempts?: number;
  readonly fetch?: FetchLike;
  readonly sleep?: Sleep;
}

export interface UploadResult {
  readonly asset: Asset;
  /** False when the server already had an identical ready file and nothing was sent. */
  readonly uploaded: boolean;
}

export const UPLOAD_ATTEMPTS = 3;

/**
 * Uploads one file content-addressed:
 *
 * 1. hashes it while streaming it from disk;
 * 2. asks for an upload (`content.upload_asset`) with the size and SHA-256. When the project
 *    already has an identical ready asset, the server answers without upload instructions and the
 *    existing asset is used: nothing is sent;
 * 3. PUTs the bytes with exactly the headers the server signed (they carry the content type, the
 *    length and the SHA-256 checksum the store verifies), streaming the file with
 *    `duplex: "half"`. Network errors and 408/429/5xx answers are retried, up to 3 attempts;
 * 4. finalizes the asset (`content.finalize_asset`) with the probe and, for a voice take, the
 *    alignment. When the server cannot find the uploaded object (`upload_missing`), the PUT is
 *    repeated within the same attempt budget.
 */
export async function uploadFile(options: UploadFileOptions): Promise<UploadResult> {
  const { platform, signal } = options;
  const { sha256, bytes } = await sha256OfFile(options.path);
  const requested = await platform.uploadAsset({
    itemId: options.itemId,
    kind: options.kind,
    filename: options.filename ?? basename(options.path),
    mime: options.mime,
    bytes,
    sha256,
  });
  if (requested.upload === null) {
    if (requested.asset.status !== "ready") {
      throw new TransferError(
        `The server returned no upload for a ${requested.asset.status} asset`,
        true,
      );
    }
    return { asset: requested.asset, uploaded: false };
  }

  const attempts = Math.max(1, options.attempts ?? UPLOAD_ATTEMPTS);
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    attempt = await putWithRetry(
      fetchImpl,
      sleep,
      requested.upload,
      options.path,
      bytes,
      signal,
      attempt,
      attempts,
    );
    try {
      const { asset } = await platform.finalizeAsset({
        assetId: requested.asset.id,
        ...(options.probe === undefined ? {} : { probe: options.probe }),
        ...(options.alignment === undefined ? {} : { alignment: options.alignment }),
      });
      if (asset.status !== "ready") {
        throw new TransferError(
          `The server did not accept the uploaded ${options.kind} (status ${asset.status})`,
          true,
        );
      }
      return { asset, uploaded: true };
    } catch (error) {
      if (error instanceof PlatformError && error.code === "upload_missing" && attempt < attempts) {
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      throw error;
    }
  }
}

/** PUTs the file until it is stored; returns the number of attempts used so far. */
async function putWithRetry(
  fetchImpl: FetchLike,
  sleep: Sleep,
  upload: UploadInstructions,
  path: string,
  bytes: number,
  signal: AbortSignal,
  used: number,
  attempts: number,
): Promise<number> {
  let attempt = used;
  for (;;) {
    attempt += 1;
    let failure: TransferError;
    try {
      const response = await fetchImpl(upload.url, {
        method: upload.method,
        headers: uploadHeaders(upload, bytes),
        body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
        duplex: "half",
        signal,
      } as RequestInit);
      // The body is not needed; release the connection.
      await response.body?.cancel().catch(() => {});
      if (response.ok) {
        return attempt;
      }
      failure = new TransferError(
        `The store refused the upload (HTTP ${response.status})`,
        isRetryableStatus(response.status),
      );
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      failure = new TransferError(`The upload failed: ${errorText(error)}`, true);
    }
    if (!failure.retryable || attempt >= attempts) {
      throw failure;
    }
    await sleep(backoffMs(attempt), signal);
  }
}

/**
 * Exactly the signed headers. A stream body needs an explicit length, so `Content-Length` is
 * added only when the server left it out (it is always signed when present).
 */
export function uploadHeaders(upload: UploadInstructions, bytes: number): Record<string, string> {
  const headers = { ...upload.headers };
  const hasLength = Object.keys(headers).some((name) => name.toLowerCase() === "content-length");
  if (!hasLength) {
    headers["Content-Length"] = String(bytes);
  }
  return headers;
}

export interface DownloadOptions {
  readonly url: string;
  readonly path: string;
  /** The expected SHA-256; a file that does not match is removed and the download fails. */
  readonly sha256?: string;
  readonly signal: AbortSignal;
  readonly attempts?: number;
  readonly fetch?: FetchLike;
  readonly sleep?: Sleep;
}

/**
 * Downloads a platform asset from its presigned URL to `path`. The bytes go to a temporary file
 * next to it, are hashed on the way and replace `path` only when the checksum matches.
 */
export async function downloadFile(
  options: DownloadOptions,
): Promise<{ sha256: string; bytes: number }> {
  const attempts = Math.max(1, options.attempts ?? UPLOAD_ATTEMPTS);
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  await mkdir(dirname(options.path), { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const temporary = join(
      dirname(options.path),
      `.${basename(options.path)}.${randomBytes(4).toString("hex")}.part`,
    );
    let failure: TransferError;
    try {
      const response = await fetchImpl(options.url, { signal: options.signal });
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => {});
        failure = new TransferError(
          `The download failed (HTTP ${response.status})`,
          isRetryableStatus(response.status),
        );
      } else {
        const hash = createHash("sha256");
        let bytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            bytes += chunk.length;
            done(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          counter,
          createWriteStream(temporary),
          { signal: options.signal },
        );
        const sha256 = hash.digest("hex");
        if (options.sha256 !== undefined && sha256 !== options.sha256.toLowerCase()) {
          await rm(temporary, { force: true });
          throw new TransferError("The downloaded file does not match its checksum", true);
        }
        await rename(temporary, options.path);
        return { sha256, bytes };
      }
    } catch (error) {
      await rm(temporary, { force: true });
      if (options.signal.aborted) {
        throw options.signal.reason;
      }
      failure =
        error instanceof TransferError
          ? error
          : new TransferError(`The download failed: ${errorText(error)}`, true);
    }
    if (!failure.retryable || attempt >= attempts) {
      throw failure;
    }
    await sleep(backoffMs(attempt), options.signal);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1));
}

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
}
