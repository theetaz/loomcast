import type { PublisherAdapter } from "../../types";
import { createInstagramAdapter } from "./adapter";

/**
 * The live Instagram Reels adapter. It sends what `requests/instagram.ts` builds, through the
 * Graph client of the server's Meta app (built on first use from `META_*`).
 */
export const instagramAdapter: PublisherAdapter = createInstagramAdapter();

export { createInstagramAdapter, type InstagramAdapterOptions } from "./adapter";
export {
  type GraphClientSource,
  graphClientFromEnv,
  INSTAGRAM_QUOTA_RETRY_MS,
  instagramErrorOf,
} from "./graph";
export { RECENT_MEDIA_LIMIT, recentMediaRequest } from "./media";
export { checkQuota, INSTAGRAM_DEFAULT_QUOTA, type InstagramQuota, parseQuota } from "./quota";
export { INSTAGRAM_REELS_MEDIA, validateInstagramReel } from "./validate";
