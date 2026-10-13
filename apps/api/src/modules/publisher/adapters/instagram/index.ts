import type { PublisherAdapter } from "../../types";
import { notConfiguredAdapter } from "../not-configured";

/**
 * The live Instagram Reels adapter. A stub until the live adapter lands: it refuses with
 * `not_configured`. The live adapter must send what `requests/instagram.ts` builds.
 */
export const instagramAdapter: PublisherAdapter = notConfiguredAdapter("instagram");

export {
  type GraphClientSource,
  graphClientFromEnv,
  INSTAGRAM_QUOTA_RETRY_MS,
  instagramErrorOf,
} from "./graph";
export { checkQuota, INSTAGRAM_DEFAULT_QUOTA, type InstagramQuota, parseQuota } from "./quota";
export { INSTAGRAM_REELS_MEDIA, validateInstagramReel } from "./validate";
