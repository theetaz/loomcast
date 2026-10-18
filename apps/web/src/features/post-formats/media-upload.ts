import {
  ASSET_KIND_MAX_BYTES,
  type Asset,
  type AssetMimeType,
  isAssetMimeTypeFor,
  type MediaType,
  mediaTypeOfMime,
} from "@loomcast/contracts";
import {
  sha256OfFile,
  type UploadStage,
  uploadAsset,
  uploadFilename,
  type XhrFactory,
} from "@/features/kb/media-upload";
import { ApiError } from "@/lib/api";

// Photos and videos of a composed post: `media` assets of the item, uploaded the same way as
// reference media (hash, presigned PUT, finalize).

/** Post media are capped like the API's `media` kind. */
export const POST_MEDIA_MAX_BYTES = ASSET_KIND_MAX_BYTES.media;

/** What the file picker offers for photos and videos. */
export const POST_MEDIA_ACCEPT =
  "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.jpg,.jpeg,.png,.webp,.mp4,.mov";

/** The file picker for formats that take photos only, or videos only. */
export const POST_MEDIA_ACCEPT_BY_TYPE: Record<MediaType, string> = {
  image: "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp",
  video: "video/mp4,video/quicktime,.mp4,.mov",
};

// Some systems leave `File.type` empty; the extension says what the file is.
const MIME_BY_EXTENSION: Record<string, AssetMimeType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
};

/** The MIME type to upload `file` as, or null when a post can't carry that kind of file. */
export function postMediaMime(file: Pick<File, "name" | "type">): AssetMimeType | null {
  if (file.type && isAssetMimeTypeFor("media", file.type)) return file.type as AssetMimeType;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return file.type === "" || file.type === "application/octet-stream"
    ? (MIME_BY_EXTENSION[extension] ?? null)
    : null;
}

/** Whether `file` is a photo or a video, or null when a post can't carry it. */
export function postMediaType(file: Pick<File, "name" | "type">): MediaType | null {
  const mime = postMediaMime(file);
  return mime ? mediaTypeOfMime(mime) : null;
}

/** Why `file` can't go in a post, or null when it can. */
export function checkPostMediaFile(file: Pick<File, "name" | "type" | "size">): string | null {
  if (!postMediaMime(file)) return "Choose a JPEG, PNG or WebP photo, or an MP4 or MOV video.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > POST_MEDIA_MAX_BYTES) return "That file is over 1 GiB, the most you can upload.";
  return null;
}

export interface PostMediaProgress {
  stage: Extract<UploadStage, "checksum" | "upload" | "verify" | "done">;
  share: number;
}

/**
 * Uploads one photo or video of a post as a `media` asset of `itemId` and returns the ready
 * asset. The same file uploaded twice for the item comes back as the asset it already has.
 */
export async function uploadPostMedia(
  file: File,
  owner: { projectId: string; itemId: string },
  options: {
    onProgress?: (progress: PostMediaProgress) => void;
    signal?: AbortSignal;
    createXhr?: XhrFactory;
  } = {},
): Promise<Asset> {
  const { onProgress, signal, createXhr } = options;
  const problem = checkPostMediaFile(file);
  if (problem) throw new ApiError(400, "validation_failed", problem);
  const mime = postMediaMime(file) as AssetMimeType;
  const report = (stage: PostMediaProgress["stage"], share = 0) => onProgress?.({ stage, share });

  report("checksum");
  const sha256 = await sha256OfFile(file, {
    signal,
    onProgress: (share) => report("checksum", share),
  });
  report("upload");
  const asset = await uploadAsset(
    file,
    {
      projectId: owner.projectId,
      itemId: owner.itemId,
      kind: "media",
      filename: uploadFilename(file.name),
      mime,
      bytes: file.size,
      sha256,
    },
    { signal, createXhr, onProgress: (stage, share) => report(stage, share) },
  );
  report("done", 1);
  return asset;
}
