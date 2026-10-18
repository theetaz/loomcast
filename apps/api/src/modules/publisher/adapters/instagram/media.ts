import { type BuildOptions, bearer, type PlatformRequest, segment } from "../../requests";

// The requests the Instagram adapter sends that the shared builders do not cover: the account's
// recent media and stories, read only to find the media of a container that is already PUBLISHED
// when its id was lost (an IG Container does not name its media). `/media` does not list stories;
// they are read from `/stories`, which holds the stories of the last 24 hours (IG User media and
// stories references, Graph API v26.0, confirmed 2026-10-18).

/** Recent media read to find a lost publish; a container lives at most 24 hours. */
export const RECENT_MEDIA_LIMIT = 25;

const RECENT_MEDIA_FIELDS = "id,permalink,timestamp,caption,media_product_type";

/** `GET /{ig-user-id}/media?fields=id,permalink,timestamp,caption,media_product_type`. */
export function recentMediaRequest(igUserId: string, options: BuildOptions): PlatformRequest {
  return {
    step: "recent_media",
    method: "GET",
    api: "graph",
    path: `/${segment(igUserId)}/media`,
    query: { fields: RECENT_MEDIA_FIELDS, limit: String(RECENT_MEDIA_LIMIT) },
    headers: { Authorization: bearer(options.accessToken) },
  };
}

/** `GET /{ig-user-id}/stories?fields=...`: the account's live stories (the last 24 hours). */
export function recentStoriesRequest(igUserId: string, options: BuildOptions): PlatformRequest {
  return {
    step: "recent_stories",
    method: "GET",
    api: "graph",
    path: `/${segment(igUserId)}/stories`,
    query: { fields: RECENT_MEDIA_FIELDS, limit: String(RECENT_MEDIA_LIMIT) },
    headers: { Authorization: bearer(options.accessToken) },
  };
}
