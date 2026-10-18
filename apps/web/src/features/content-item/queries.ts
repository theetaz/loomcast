import type {
  Asset,
  AssetKind,
  ContentAction,
  ContentItemDetail,
  ContentVersion,
  ContentVersionSummary,
  CreateReviewRequest,
  EditVersionRequest,
  JobSummary,
  List,
  ProduceTarget,
  Review,
} from "@loomcast/contracts";
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { cacheJob } from "@/features/conversation/queries";
import {
  contentItemQueryOptions,
  contentKeys,
  upsertContentItem,
} from "@/features/library/queries";
import { api } from "@/lib/api";

export { contentItemQueryOptions, contentKeys };

/** Query keys of the item page, next to the library's `["content", "detail", id]`. */
export const itemKeys = {
  version: (itemId: string, versionId: string) =>
    ["content", "version", itemId, versionId] as const,
  assets: (itemId: string, kind?: AssetKind) =>
    ["content", "assets", itemId, kind ?? "all"] as const,
  allAssets: (itemId: string) => ["content", "assets", itemId] as const,
  reviews: (itemId: string) => ["content", "reviews", itemId] as const,
  conversation: (itemId: string) => ["content", "conversation", itemId] as const,
  asset: (assetId: string) => ["assets", "detail", assetId] as const,
  series: (seriesId: string) => ["series", "detail", seriesId] as const,
  format: (formatId: string) => ["formats", "detail", formatId] as const,
  formatVersions: (formatId: string) => ["formats", "versions", formatId] as const,
};

/** A version with its artifacts. Versions never change, so they are read once. */
export function versionQueryOptions(itemId: string, versionId: string) {
  return queryOptions({
    queryKey: itemKeys.version(itemId, versionId),
    queryFn: ({ signal }) =>
      api.request("content.versions.get", { params: { id: itemId, versionId }, signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function itemAssetsQueryOptions(itemId: string, kind?: AssetKind) {
  return queryOptions({
    queryKey: itemKeys.assets(itemId, kind),
    queryFn: ({ signal }) =>
      api.request("content.assets", {
        params: { id: itemId },
        query: kind ? { kind } : {},
        signal,
      }),
    select: (list: List<Asset>) => list.items,
  });
}

export function assetQueryOptions(assetId: string) {
  return queryOptions({
    queryKey: itemKeys.asset(assetId),
    queryFn: ({ signal }) => api.request("assets.get", { params: { id: assetId }, signal }),
    staleTime: 60_000,
  });
}

export function reviewsQueryOptions(itemId: string) {
  return queryOptions({
    queryKey: itemKeys.reviews(itemId),
    queryFn: ({ signal }) => api.request("reviews.list", { params: { id: itemId }, signal }),
    select: (list: List<Review>) => list.items,
  });
}

/** The item's producer conversation; the API creates it on first use. */
export function itemConversationQueryOptions(itemId: string) {
  return queryOptions({
    queryKey: itemKeys.conversation(itemId),
    queryFn: () => api.request("content.conversation", { params: { id: itemId } }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * The length the item's format aims for: its series' format, at the version the content was
 * produced with when that is known. `null` while loading or when the item has no series.
 */
export function useFormatTarget(seriesId: string | null, formatVersionId: string | null) {
  const series = useQuery({
    queryKey: itemKeys.series(seriesId ?? ""),
    queryFn: ({ signal }) => api.request("series.get", { params: { id: seriesId ?? "" }, signal }),
    enabled: seriesId !== null,
    staleTime: 60_000,
  });
  const formatId = series.data?.formatId;
  const format = useQuery({
    queryKey: itemKeys.format(formatId ?? ""),
    queryFn: ({ signal }) => api.request("formats.get", { params: { id: formatId ?? "" }, signal }),
    enabled: Boolean(formatId),
    staleTime: 60_000,
  });
  const needsHistory =
    format.data !== undefined &&
    formatVersionId !== null &&
    format.data.currentVersion.id !== formatVersionId;
  const versions = useQuery({
    queryKey: itemKeys.formatVersions(formatId ?? ""),
    queryFn: ({ signal }) =>
      api.request("formats.versions", { params: { id: formatId ?? "" }, signal }),
    enabled: needsHistory,
    staleTime: 60_000,
  });
  const produced = versions.data?.items.find((version) => version.id === formatVersionId);
  const rules = (needsHistory ? produced : undefined)?.rules ?? format.data?.currentVersion.rules;
  return {
    series: series.data ?? null,
    formatName: format.data?.name ?? null,
    rules: rules ?? null,
  };
}

// Cache updates ---------------------------------------------------------------------

function summaryOf(version: ContentVersion): ContentVersionSummary {
  const { script: _script, storyboard: _storyboard, caption: _caption, ...rest } = version;
  return rest;
}

/** Puts a new current version into the open item, ahead of a refetch. */
export function cacheNewVersion(queryClient: QueryClient, itemId: string, version: ContentVersion) {
  queryClient.setQueryData(itemKeys.version(itemId, version.id), version);
  queryClient.setQueryData<ContentItemDetail>(contentKeys.detail(itemId), (detail) =>
    detail
      ? {
          ...detail,
          currentVersion: version,
          versions: [
            summaryOf(version),
            ...detail.versions.filter((entry) => entry.id !== version.id),
          ],
        }
      : detail,
  );
}

/** Records a job the item now runs, so the banner shows it before the next refetch. */
export function cacheActiveJob(queryClient: QueryClient, itemId: string, job: JobSummary) {
  cacheJob(queryClient, job);
  queryClient.setQueryData<ContentItemDetail>(contentKeys.detail(itemId), (detail) =>
    detail ? { ...detail, activeJob: job } : detail,
  );
}

// Mutations -------------------------------------------------------------------------

export function useRenameItem(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title: string) =>
      api.request("content.update", { params: { id: itemId }, body: { title } }),
    onSuccess: (item) => upsertContentItem(queryClient, item),
  });
}

/**
 * Writes a new version on top of `baseVersionId`. A `409 conflict` means another version arrived
 * first; callers show it and offer to reload.
 */
export function useEditVersion(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: EditVersionRequest) =>
      api.request("content.versions.edit", { params: { id: itemId }, body }),
    onSuccess: ({ item, version }) => {
      cacheNewVersion(queryClient, itemId, version);
      upsertContentItem(queryClient, item);
      void queryClient.invalidateQueries({ queryKey: itemKeys.allAssets(itemId) });
    },
  });
}

export function useItemAction(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, through }: { action: ContentAction; through?: ProduceTarget }) =>
      api.request("content.actions", {
        params: { id: itemId },
        body: through ? { action, through } : { action },
      }),
    onSuccess: (job) => cacheActiveJob(queryClient, itemId, job),
  });
}

export function useReviewItem(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateReviewRequest) =>
      api.request("reviews.create", { params: { id: itemId }, body }),
    onSuccess: ({ review, item }) => {
      queryClient.setQueryData<List<Review>>(itemKeys.reviews(itemId), (list) =>
        list ? { items: [review, ...list.items.filter((entry) => entry.id !== review.id)] } : list,
      );
      void queryClient.invalidateQueries({ queryKey: itemKeys.reviews(itemId) });
      upsertContentItem(queryClient, item);
      // A request for changes may have queued a revision: read the active job.
      void queryClient.invalidateQueries({ queryKey: contentKeys.detail(itemId) });
    },
  });
}

/** Sends the current version to review: a composed post whose media fit, or a finished render. */
export function useSubmitItem(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      api.request("content.submit", { params: { id: itemId }, body: { versionId } }),
    onSuccess: (item) => {
      upsertContentItem(queryClient, item);
      void queryClient.invalidateQueries({ queryKey: ["reviews", "queue"] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}

export function useArchive(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.request("content.archive", { params: { id: itemId } }),
    onSuccess: (item) => upsertContentItem(queryClient, item),
  });
}

export function useRestore(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.request("content.restore", { params: { id: itemId } }),
    onSuccess: (item) => upsertContentItem(queryClient, item),
  });
}

export function useCancelJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.request("jobs.cancel", { params: { id: jobId } }),
    onSuccess: (job) => cacheJob(queryClient, job),
  });
}
