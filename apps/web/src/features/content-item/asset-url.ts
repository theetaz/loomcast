import type { AssetUrl } from "@loomcast/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect } from "react";
import { api, isApiError } from "@/lib/api";

/** Presigned URLs are refreshed this long before they expire. */
export const URL_REFRESH_MARGIN_MS = 60_000;
/** The soonest a refresh runs, so a URL that is already close to expiry can't loop. */
export const URL_MIN_REFRESH_MS = 1_000;
/** How often a file that is still being processed (409) is asked for again. */
export const NOT_READY_RETRY_MS = 3_000;

/** Milliseconds until a URL expiring at `expiresAt` should be replaced. */
export function refreshDelay(expiresAt: string, now: number = Date.now()): number {
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return URL_MIN_REFRESH_MS;
  return Math.max(URL_MIN_REFRESH_MS, expires - now - URL_REFRESH_MARGIN_MS);
}

export type Disposition = "inline" | "attachment";

/**
 * A presigned GET URL for a ready asset. It stays fresh until shortly before it expires and is
 * replaced on a timer before then, so a player never holds a dead link. A `409` means the file is
 * still being processed; it is asked for again every few seconds.
 */
export function assetUrlQueryOptions(assetId: string, disposition: Disposition = "inline") {
  return queryOptions({
    queryKey: ["assets", "url", assetId, disposition] as const,
    queryFn: ({ signal }) =>
      api.request("assets.url", {
        params: { id: assetId },
        query: disposition === "inline" ? {} : { disposition },
        signal,
      }),
    staleTime: (query) => {
      const data = query.state.data as AssetUrl | undefined;
      return data ? refreshDelay(data.expiresAt) : 0;
    },
    refetchInterval: (query) => {
      const data = query.state.data as AssetUrl | undefined;
      return data ? refreshDelay(data.expiresAt) : false;
    },
    refetchIntervalInBackground: true,
    retry: (failures, error) => isApiError(error, 409) && failures < 40,
    retryDelay: NOT_READY_RETRY_MS,
  });
}

export function useAssetUrl(assetId: string | null | undefined, disposition?: Disposition) {
  return useQuery({
    ...assetUrlQueryOptions(assetId ?? "", disposition),
    enabled: Boolean(assetId),
  });
}

/**
 * Points a media element at `url` and keeps its place when the URL is replaced: a refreshed link
 * resumes at the same time, and keeps playing only if it was playing. Never starts playback on its
 * own.
 */
export function useMediaSource(ref: RefObject<HTMLMediaElement | null>, url: string | undefined) {
  useEffect(() => {
    const element = ref.current;
    if (!element || !url || element.getAttribute("src") === url) return;
    const hadSource = element.hasAttribute("src");
    const time = element.currentTime;
    const wasPlaying = hadSource && !element.paused && !element.ended;
    element.src = url;
    if (!hadSource || time === 0) return;
    const resume = () => {
      element.currentTime = time;
      if (wasPlaying) void element.play().catch(() => {});
    };
    element.addEventListener("loadedmetadata", resume, { once: true });
    return () => element.removeEventListener("loadedmetadata", resume);
  }, [ref, url]);
}
