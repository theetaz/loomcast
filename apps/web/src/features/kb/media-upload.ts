import {
  ASSET_FILENAME_MAX_LENGTH,
  ASSET_KIND_MAX_BYTES,
  type Asset,
  type AssetMimeType,
  type CreateUploadRequest,
  isAssetMimeTypeFor,
  type JobSummary,
  type KbEntryDetail,
  type UploadInstructions,
} from "@loomcast/contracts";
import { createSHA256 } from "hash-wasm";
import { ApiError, api, isApiError } from "@/lib/api";

/** Reference media is capped at 1 GiB, like the API's `reference_media` kind. */
export const REFERENCE_MEDIA_MAX_BYTES = ASSET_KIND_MAX_BYTES.reference_media;

/** Bytes read and hashed at a time, so a 1 GiB file never sits in memory whole. */
export const HASH_CHUNK_BYTES = 8 * 1024 * 1024;

export const RIGHTS_NOTICE = "Only upload media you own or have permission to use.";

/** What the file picker offers. */
export const REFERENCE_MEDIA_ACCEPT =
  "video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,.mp4,.mov,.mp3,.wav,.m4a";

// Some systems leave `File.type` empty for these; the extension says what they are.
const MIME_BY_EXTENSION: Record<string, AssetMimeType> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/x-m4a",
};

/** The MIME type to upload `file` as, or null when reference media can't be that kind of file. */
export function referenceMediaMime(file: Pick<File, "name" | "type">): AssetMimeType | null {
  if (file.type && isAssetMimeTypeFor("reference_media", file.type)) {
    return file.type as AssetMimeType;
  }
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return file.type === "" || file.type === "application/octet-stream"
    ? (MIME_BY_EXTENSION[extension] ?? null)
    : null;
}

/** Why `file` can't be uploaded as reference media, or null when it can. */
export function checkReferenceFile(file: Pick<File, "name" | "type" | "size">): string | null {
  if (!referenceMediaMime(file)) {
    return "Choose an MP4 or MOV video, or an MP3, WAV or M4A audio file.";
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > REFERENCE_MEDIA_MAX_BYTES)
    return "That file is over 1 GiB, the most you can upload.";
  return null;
}

/** A file name the API accepts: no folders or control characters, at most 255 characters. */
export function uploadFilename(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  const cleaned = name.replace(/[/\\\u0000-\u001f\u007f]/g, "_").trim();
  const safe = cleaned === "" || cleaned === "." || cleaned === ".." ? "reference" : cleaned;
  return safe.slice(0, ASSET_FILENAME_MAX_LENGTH);
}

function readChunk(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file"));
    reader.readAsArrayBuffer(blob);
  });
}

function abortError(): DOMException {
  return new DOMException("The upload was cancelled", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

type Hasher = Awaited<ReturnType<typeof createSHA256>>;

/**
 * The incremental hasher. It runs on WebAssembly, which a Content-Security-Policy without
 * `'wasm-unsafe-eval'` refuses; then the answer is null and the caller falls back.
 */
async function wasmHasher(): Promise<Hasher | null> {
  try {
    return await createSHA256();
  } catch {
    return null;
  }
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The SHA-256 of `file` as lowercase hex, read in `chunkBytes` slices so memory stays flat.
 * `onProgress` gets the share hashed so far (0 to 1). Where WebAssembly is unavailable it hashes
 * the whole file at once with Web Crypto, which needs the file in memory and reports no progress
 * until the end.
 */
export async function sha256OfFile(
  file: Blob,
  options: {
    onProgress?: (share: number) => void;
    signal?: AbortSignal;
    chunkBytes?: number;
    /** For tests: the incremental hasher, or null to take the Web Crypto path. */
    hasher?: Hasher | null;
  } = {},
): Promise<string> {
  const { onProgress, signal, chunkBytes = HASH_CHUNK_BYTES } = options;
  const hasher = options.hasher !== undefined ? options.hasher : await wasmHasher();
  if (!hasher) {
    if (signal?.aborted) throw abortError();
    const digest = await crypto.subtle.digest("SHA-256", await readChunk(file));
    if (signal?.aborted) throw abortError();
    onProgress?.(1);
    return toHex(digest);
  }
  hasher.init();
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    if (signal?.aborted) throw abortError();
    const chunk = await readChunk(file.slice(offset, offset + chunkBytes));
    hasher.update(new Uint8Array(chunk));
    onProgress?.(Math.min(1, (offset + chunk.byteLength) / file.size));
  }
  if (signal?.aborted) throw abortError();
  return hasher.digest("hex");
}

/** A failed PUT to storage. `status` is 0 when the request never got an answer. */
export class StorageUploadError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 0 ? "The upload was interrupted" : `Storage answered ${status}`);
    this.name = "StorageUploadError";
    this.status = status;
  }
}

/** Headers the browser sets itself and refuses from scripts. */
const BROWSER_HEADERS = new Set(["content-length", "host", "connection"]);

export type XhrFactory = () => XMLHttpRequest;

/**
 * PUTs `file` to the presigned URL with the instructions' headers, reporting upload progress
 * (0 to 1). XHR rather than fetch, because fetch reports no upload progress. The browser sets
 * `Content-Length` itself from the body.
 */
export function putFile(
  upload: UploadInstructions,
  file: Blob,
  options: {
    onProgress?: (share: number) => void;
    signal?: AbortSignal;
    createXhr?: XhrFactory;
  } = {},
): Promise<void> {
  const { onProgress, signal, createXhr = () => new XMLHttpRequest() } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = createXhr();
    const onAbort = () => xhr.abort();
    xhr.open(upload.method, upload.url);
    for (const [name, value] of Object.entries(upload.headers)) {
      if (!BROWSER_HEADERS.has(name.toLowerCase())) xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
      if (total > 0) onProgress?.(Math.min(1, event.loaded / total));
    };
    xhr.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
      } else {
        reject(new StorageUploadError(xhr.status));
      }
    };
    xhr.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new StorageUploadError(0));
    };
    xhr.onabort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(file);
  });
}

/** The steps of an upload, in order. */
export type UploadStage = "checksum" | "upload" | "verify" | "attach" | "analyze" | "done";

export interface UploadProgress {
  stage: UploadStage;
  /** The current step's share done, 0 to 1, for the steps that measure it. */
  share: number;
}

/**
 * Stores a hashed file as an asset: asks the API for an upload (`assets.createUpload`), PUTs the
 * bytes with progress unless the owner already has the same file (`upload: null`), then finalizes
 * the asset, which checks its size and checksum. A `409 upload_missing` PUTs once more. Reports
 * `upload` and `verify` as it goes.
 */
export async function uploadAsset(
  file: Blob,
  request: CreateUploadRequest,
  options: {
    onProgress?: (stage: "upload" | "verify", share: number) => void;
    signal?: AbortSignal;
    createXhr?: XhrFactory;
  } = {},
): Promise<Asset> {
  const { onProgress, signal, createXhr } = options;
  const report = (stage: "upload" | "verify", share = 0) => onProgress?.(stage, share);
  const created = await api.request("assets.createUpload", { body: request, signal });

  let asset = created.asset;
  if (!created.upload) {
    report("upload", 1);
    return asset;
  }
  const upload = created.upload;
  const put = () =>
    putFile(upload, file, {
      signal,
      createXhr,
      onProgress: (share) => report("upload", share),
    });
  await put();
  report("verify");
  try {
    asset = await api.request("assets.finalize", { params: { id: asset.id }, body: {}, signal });
  } catch (error) {
    if (!(isApiError(error, 409) && error.code === "upload_missing")) throw error;
    report("upload");
    await put();
    report("verify");
    asset = await api.request("assets.finalize", { params: { id: asset.id }, body: {}, signal });
  }
  if (asset.status !== "ready") {
    throw new ApiError(
      422,
      "upload_failed",
      "The uploaded file didn't match its checksum. Try the upload again.",
    );
  }
  return asset;
}

export interface ReferenceUploadResult {
  asset: Asset;
  entry: KbEntryDetail;
  /** The analysis job, or null when it couldn't start (the media stays attached). */
  job: JobSummary | null;
  analyzeError: unknown;
}

/**
 * Uploads reference media and attaches it to a reference:
 *
 * 1. hashes the file in slices (SHA-256, the checksum storage verifies);
 * 2. asks the API for an upload (`assets.createUpload`, kind `reference_media`);
 * 3. PUTs the bytes with progress, unless the workspace already has the same file (`upload: null`);
 * 4. finalizes the asset, which checks its size and checksum (a `409 upload_missing` PUTs again);
 * 5. sets the reference's `mediaAssetId` (re-reading the entry once if it changed meanwhile);
 * 6. starts the analysis.
 */
export async function uploadReferenceMedia(
  file: File,
  entry: KbEntryDetail,
  options: {
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
    createXhr?: XhrFactory;
  } = {},
): Promise<ReferenceUploadResult> {
  const { onProgress, signal, createXhr } = options;
  const problem = checkReferenceFile(file);
  if (problem) throw new ApiError(400, "validation_failed", problem);
  const mime = referenceMediaMime(file) as AssetMimeType;
  const report = (stage: UploadStage, share = 0) => onProgress?.({ stage, share });

  report("checksum");
  const sha256 = await sha256OfFile(file, {
    signal,
    onProgress: (share) => report("checksum", share),
  });

  report("upload");
  const asset = await uploadAsset(
    file,
    {
      workspaceId: entry.workspaceId,
      kind: "reference_media",
      filename: uploadFilename(file.name),
      mime,
      bytes: file.size,
      sha256,
    },
    { signal, createXhr, onProgress: (stage, share) => report(stage, share) },
  );

  report("attach");
  const attach = (base: KbEntryDetail) =>
    api.request("kb.update", {
      params: { id: base.id },
      body: { expectedUpdatedAt: base.updatedAt, mediaAssetId: asset.id },
      signal,
    });
  let updated: KbEntryDetail;
  try {
    updated = await attach(entry);
  } catch (error) {
    if (!isApiError(error, 409)) throw error;
    const latest = await api.request("kb.get", { params: { id: entry.id }, signal });
    updated = await attach(latest);
  }

  report("analyze");
  let job: JobSummary | null = null;
  let analyzeError: unknown = null;
  try {
    job = await api.request("kb.analyze", { params: { id: entry.id }, signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    analyzeError = error;
  }
  report("done", 1);
  return { asset, entry: updated, job, analyzeError };
}
