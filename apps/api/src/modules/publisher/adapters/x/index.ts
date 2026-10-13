import type { PublisherAdapter } from "../../types";
import { createXAdapter } from "./adapter";
import { X_DISABLED } from "./config";

export {
  createXAdapter,
  X_POST_MAX_WEIGHTED_LENGTH,
  type XAdapterOptions,
  xPermalink,
} from "./adapter";
export {
  classifyXError,
  createXClient,
  parseXRateLimit,
  X_API_TIMEOUT_MS,
  X_RATE_LIMIT_FALLBACK_MS,
  XApiError,
  type XClient,
  type XClientOptions,
  type XRateLimit,
  type XRequest,
  type XResponse,
  xRetryAfterMs,
} from "./client";
export {
  isXPublishingEnabled,
  usableXApp,
  X_DISABLED,
  type XPlatforms,
  xClientFor,
} from "./config";
export {
  exchangeXCode,
  getXUser,
  refreshXToken,
  X_AUTHORIZE_URL,
  X_SCOPES,
  X_TOKEN_PATH,
  type XTokenPair,
  type XUser,
  xAuthorizeUrl,
} from "./oauth";
export {
  type FreshXToken,
  freshXAccessToken,
  saveXRateLimit,
  X_TOKEN_REFRESH_LEAD_MS,
  type XTokenStore,
} from "./tokens";
export {
  segmentsOf,
  storageMediaSource,
  toXRequest,
  type UploadedXMedia,
  uploadXVideo,
  type XMediaSource,
  type XProcessingInfo,
  xUploadStatus,
} from "./upload";

/**
 * The X adapter of the registry: X publishing off, so it refuses every post with
 * `not_configured` and never calls X. The publisher module builds the live one with
 * `createXAdapter` from the server's settings (`FEATURE_X_PUBLISHING`, `X_CLIENT_*`), the
 * credential store and the render storage.
 */
export const xAdapter: PublisherAdapter = createXAdapter({ platforms: X_DISABLED });
