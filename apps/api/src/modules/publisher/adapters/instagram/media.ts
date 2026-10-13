import { type BuildOptions, bearer, type PlatformRequest, segment } from "../../requests";

// The one request the Instagram adapter sends that the shared builders do not cover: the
// account's recent media, read only to find the media of a container that is already PUBLISHED
// when its id was lost (an IG Container does not name its media).

/** Recent media read to find a lost publish; a container lives at most 24 hours. */
export const RECENT_MEDIA_LIMIT = 25;

/** `GET /{ig-user-id}/media?fields=id,permalink,timestamp,caption,media_product_type`. */
export function recentMediaRequest(igUserId: string, options: BuildOptions): PlatformRequest {
  return {
    step: "recent_media",
    method: "GET",
    api: "graph",
    path: `/${segment(igUserId)}/media`,
    query: {
      fields: "id,permalink,timestamp,caption,media_product_type",
      limit: String(RECENT_MEDIA_LIMIT),
    },
    headers: { Authorization: bearer(options.accessToken) },
  };
}
