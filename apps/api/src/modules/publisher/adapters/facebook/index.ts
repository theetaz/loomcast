import type { PublisherAdapter } from "../../types";
import { createFacebookAdapter } from "./adapter";
import { UNCONFIGURED_META_PLATFORMS } from "./meta-call";

export { createFacebookAdapter } from "./adapter";
export {
  type CredentialsRefusal,
  type CredentialsRefusalReason,
  clientOptions,
  credentialsOf,
  type MetaAdapterOptions,
  type MetaPlatforms,
  metaCall,
  refusesCredentials,
  stepOf,
  toGraphRequest,
  UNCONFIGURED_META_PLATFORMS,
} from "./meta-call";
export { createRuploadClient, RUPLOAD_BASE_URL, type RuploadClient, ruploadError } from "./rupload";
export {
  FACEBOOK_ORIGIN,
  type FacebookVideo,
  FacebookVideoSchema,
  facebookPermalink,
  facebookStatusOf,
  finishTookEffect,
} from "./status";

/**
 * The Facebook Page Reels adapter of the registry, without a Meta app: it refuses with
 * `not_configured`. The publisher module builds the configured one with `createFacebookAdapter`
 * from the server's platform settings and the channels module's reauth path.
 */
export const facebookAdapter: PublisherAdapter = createFacebookAdapter({
  platforms: UNCONFIGURED_META_PLATFORMS,
});
