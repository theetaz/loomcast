import type { PublisherAdapter } from "../../types";
import { createInstagramAdapter } from "./adapter";

/**
 * The live Instagram adapter: Reels, photos, carousels and stories. It sends what
 * `requests/instagram.ts` builds, through the Graph client of the server's Meta app (built on
 * first use from `META_*`).
 */
export const instagramAdapter: PublisherAdapter = createInstagramAdapter();

export {
  createInstagramAdapter,
  type InstagramAdapterOptions,
  stagedCarouselId,
  stagedItemIds,
} from "./adapter";
export {
  type GraphClientSource,
  graphClientFromEnv,
  INSTAGRAM_QUOTA_RETRY_MS,
  instagramErrorOf,
} from "./graph";
export { RECENT_MEDIA_LIMIT, recentMediaRequest, recentStoriesRequest } from "./media";
export { checkQuota, INSTAGRAM_DEFAULT_QUOTA, type InstagramQuota, parseQuota } from "./quota";
export { INSTAGRAM_REELS_MEDIA, validateInstagramPost } from "./validate";
