import type {
  ContentItem,
  ContentVersion,
  CreateContentItemRequest,
  PostFormat,
} from "@loomcast/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cacheNewVersion } from "@/features/content-item/queries";
import type { XhrFactory } from "@/features/kb/media-upload";
import { contentKeys, upsertContentItem } from "@/features/library/queries";
import { type PostMediaProgress, uploadPostMedia } from "@/features/post-formats/media-upload";
import { api, isApiError } from "@/lib/api";
import { type MediaDraft, mediaEntries } from "./draft";

/** What a save got done so far, so a failed save picks up where it stopped. */
export interface SavedSoFar {
  item: ContentItem | null;
  /** Asset ids of the files already uploaded, by draft key. */
  uploaded: Record<string, string>;
}

export interface SavePostInput {
  projectId: string;
  format: PostFormat;
  title: string;
  seriesId: string | null;
  caption: string;
  media: readonly MediaDraft[];
  /** Left by an earlier attempt: the item is not created twice, nor a file uploaded twice. */
  progress: SavedSoFar;
}

export interface SavePostCallbacks {
  onCreated?: (item: ContentItem) => void;
  onUploadProgress?: (key: string, progress: PostMediaProgress) => void;
  onUploaded?: (key: string, assetId: string) => void;
  signal?: AbortSignal;
  createXhr?: XhrFactory;
}

/**
 * Saves a composed post:
 *
 * 1. creates the item with its format (`content.create`), unless an earlier attempt did;
 * 2. uploads each photo and video as a `media` asset of the item, in order;
 * 3. writes the version with the media and the caption (`content.versions.edit`), which takes a
 *    post whose media fit its format to `render`; one still missing media stays an `idea`. A
 *    stale base version is read again once.
 */
export async function savePost(
  input: SavePostInput,
  callbacks: SavePostCallbacks = {},
): Promise<{ item: ContentItem; version: ContentVersion }> {
  const { signal, createXhr } = callbacks;
  let item = input.progress.item;
  if (!item) {
    const body: CreateContentItemRequest = {
      title: input.title,
      format: input.format,
      ...(input.seriesId ? { seriesId: input.seriesId } : {}),
    };
    const detail = await api.request("content.create", {
      params: { projectId: input.projectId },
      body,
      signal,
    });
    item = detail.item;
    callbacks.onCreated?.(item);
  }
  const created: ContentItem = item;
  const owner = { projectId: created.projectId, itemId: created.id };

  const uploaded: MediaDraft[] = [];
  for (const draft of input.media) {
    let assetId = draft.assetId ?? input.progress.uploaded[draft.key];
    if (!assetId) {
      const asset = await uploadPostMedia(draft.file, owner, {
        signal,
        createXhr,
        onProgress: (progress) => callbacks.onUploadProgress?.(draft.key, progress),
      });
      assetId = asset.id;
      callbacks.onUploaded?.(draft.key, assetId);
    }
    uploaded.push({ ...draft, assetId });
  }

  const caption = input.caption.trim();
  if (uploaded.length === 0 && caption === "" && created.format === input.format) {
    // Nothing to write yet: the bare idea is the draft.
    const detail = await api.request("content.get", { params: { id: owner.itemId }, signal });
    return { item: detail.item, version: detail.currentVersion };
  }
  const edit = (baseVersionId: string) =>
    api.request("content.versions.edit", {
      params: { id: owner.itemId },
      body: {
        baseVersionId,
        // The item was created with its format; a retry after the format changed sets it again.
        ...(created.format === input.format ? {} : { format: input.format }),
        media: mediaEntries(uploaded),
        caption: caption || null,
      },
      signal,
    });
  try {
    return await edit(created.currentVersionId);
  } catch (error) {
    if (!(isApiError(error, 409) && error.code === "conflict")) throw error;
    const latest = await api.request("content.get", { params: { id: owner.itemId }, signal });
    return edit(latest.item.currentVersionId);
  }
}

/** Saves a composed post and puts the item and its version in the caches. */
export function useSavePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input, callbacks }: { input: SavePostInput; callbacks?: SavePostCallbacks }) =>
      savePost(input, callbacks),
    onSuccess: ({ item, version }) => {
      cacheNewVersion(queryClient, item.id, version);
      upsertContentItem(queryClient, item);
      void queryClient.invalidateQueries({ queryKey: contentKeys.detail(item.id) });
    },
  });
}
