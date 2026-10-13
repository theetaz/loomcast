import type { JsonObject } from "@loomcast/contracts";
import { z } from "zod";
import type { Storage } from "../../../../lib/storage";
import type { AssetsService } from "../../../assets/service";
import { PublishFailure } from "../../errors";
import type { MediaFacts, PlatformRequest } from "../../requests/types";
import { X_SEGMENT_BYTES, xRequests, xSegments } from "../../requests/x";
import type { PublishMedia } from "../../types";
import type { XClient, XRateLimit, XRequest } from "./client";

// The X v2 chunked media upload, as documented at docs.x.com (media upload, chunked; checked
// 2026-10-13):
// - `POST /2/media/upload/initialize` JSON {media_type, total_bytes, media_category} → data.id
// - `POST /2/media/upload/{id}/append` multipart {segment_index, media}, segments of 4 MB (the
//   server takes up to 8 MB; 5 MB or less is advised), `segment_index` from 0
// - `POST /2/media/upload/{id}/finalize` → data.processing_info when the video still processes
// - `GET /2/media/upload?command=STATUS&media_id={id}` → data.processing_info {state:
//   pending|in_progress|succeeded|failed, check_after_secs, progress_percent, error}
// No `processing_info` after finalize means the media is ready. The bytes are streamed from
// object storage segment by segment, so at most one segment is held in memory.

/** Opens the render's bytes. */
export type XMediaSource = (
  media: PublishMedia,
  signal: AbortSignal,
) => Promise<AsyncIterable<Uint8Array>>;

/** Streams the render from the private bucket. */
export function storageMediaSource(services: {
  storage: Pick<Storage, "getStream">;
  assets: Pick<AssetsService, "getRow">;
}): XMediaSource {
  return async (media) => {
    const row = await services.assets.getRow(media.renderAssetId);
    if (row === null || row.status !== "ready") {
      throw PublishFailure.of("invalid_media", "The file to publish is missing.", {
        retryable: false,
      });
    }
    try {
      return await services.storage.getStream(row.storageKey);
    } catch {
      throw PublishFailure.of("transient", "The file could not be read from storage.");
    }
  };
}

const ProcessingInfoSchema = z.object({
  state: z.enum(["pending", "in_progress", "succeeded", "failed"]),
  check_after_secs: z.number().optional(),
  progress_percent: z.number().optional(),
  error: z
    .object({
      code: z.number().optional(),
      name: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});
export type XProcessingInfo = z.infer<typeof ProcessingInfoSchema>;

const MediaResponseSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    processing_info: ProcessingInfoSchema.optional(),
  }),
});

function parseMedia(data: unknown, step: string): z.infer<typeof MediaResponseSchema>["data"] {
  const parsed = MediaResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw PublishFailure.of("transient", `The X API answered ${step} in an unexpected form.`);
  }
  return parsed.data.data;
}

/** A builder step as an X client call with the real token and, for appends, the bytes. */
export function toXRequest(
  step: PlatformRequest,
  accessToken: string,
  signal: AbortSignal,
  segment?: Uint8Array,
): XRequest {
  const base: XRequest = {
    method: step.method,
    path: step.path,
    accessToken,
    signal,
    ...(step.query === undefined ? {} : { query: step.query }),
  };
  if (segment !== undefined) {
    const form = new FormData();
    form.set("segment_index", String(step.body?.segment_index ?? 0));
    form.set("media", new Blob([segment as Uint8Array<ArrayBuffer>]), "segment");
    return { ...base, multipart: form };
  }
  if (step.bodyEncoding === "json" && step.body !== undefined) {
    return { ...base, json: step.body as unknown as JsonObject };
  }
  return base;
}

/**
 * Cuts a byte stream into exact `size`-byte segments (the last one shorter), holding at most one
 * segment and one incoming chunk.
 */
export async function* segmentsOf(
  source: AsyncIterable<Uint8Array>,
  size: number = X_SEGMENT_BYTES,
): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(size);
  let filled = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(size - filled, chunk.length - offset);
      buffer.set(chunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === size) {
        yield buffer;
        buffer = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) {
    yield buffer.slice(0, filled);
  }
}

export interface UploadedXMedia {
  mediaId: string;
  /** Null when the media was ready at once. */
  processing: XProcessingInfo | null;
  rateLimit: XRateLimit | null;
}

/**
 * Uploads the render: initialize, one append per 4 MB segment streamed from `open`, finalize.
 * The stream must hold exactly `media.bytes` bytes; anything else fails as `transient` before
 * finalize, so X never processes a truncated file.
 */
export async function uploadXVideo(input: {
  client: XClient;
  accessToken: string;
  media: MediaFacts;
  open: () => Promise<AsyncIterable<Uint8Array>>;
  signal: AbortSignal;
}): Promise<UploadedXMedia> {
  const { client, accessToken, media, signal } = input;
  const options = { accessToken };
  const init = await client.request(
    toXRequest(xRequests.initialize(media, options), accessToken, signal),
  );
  const mediaId = parseMedia(init.data, "the upload initialize").id;

  const ranges = xSegments(media.bytes);
  let index = 0;
  let sent = 0;
  for await (const segment of segmentsOf(await input.open())) {
    const range = ranges[index];
    if (range === undefined || segment.length !== range.end - range.start) {
      throw PublishFailure.of("transient", "The stored file does not match its recorded size.");
    }
    await client.request(
      toXRequest(xRequests.append(mediaId, index, range, options), accessToken, signal, segment),
    );
    sent += segment.length;
    index += 1;
  }
  if (sent !== media.bytes) {
    throw PublishFailure.of("transient", "The stored file does not match its recorded size.");
  }

  const finalized = await client.request(
    toXRequest(xRequests.finalize(mediaId, options), accessToken, signal),
  );
  const done = parseMedia(finalized.data, "the upload finalize");
  return {
    mediaId,
    processing: done.processing_info ?? null,
    rateLimit: finalized.rateLimit,
  };
}

/** `GET /2/media/upload?command=STATUS`: the upload's processing state. */
export async function xUploadStatus(input: {
  client: XClient;
  accessToken: string;
  mediaId: string;
  signal: AbortSignal;
}): Promise<{ processing: XProcessingInfo | null; rateLimit: XRateLimit | null }> {
  const response = await input.client.request(
    toXRequest(
      xRequests.status(input.mediaId, { accessToken: input.accessToken }),
      input.accessToken,
      input.signal,
    ),
  );
  return {
    processing: parseMedia(response.data, "the upload status").processing_info ?? null,
    rateLimit: response.rateLimit,
  };
}
