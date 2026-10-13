// The Graph API and Threads API client: versioned base URLs, `appsecret_proof`, timeouts and
// retries, throttling headers and error classification, plus the calls of the sign-in flows and
// the token checks. Publisher adapters build on `createMetaGraphClient` and
// `createThreadsGraphClient` as well.

export {
  createGraphClient,
  type FetchLike,
  type GraphClient,
  type GraphClientOptions,
  type GraphParams,
  type GraphRequest,
  type GraphResponse,
  META_GRAPH_MAX_RETRIES,
  META_GRAPH_RETRY_BASE_MS,
  META_GRAPH_TIMEOUT_MS,
} from "./client";
export {
  classifyMetaError,
  classifyMetaErrorCode,
  type GraphErrorFields,
  MetaGraphError,
  metaPlatformCode,
  sanitizeMetaMessage,
} from "./errors";
export * from "./meta";
export { parseGraph } from "./parse";
export { appAccessToken, appSecretProof } from "./proof";
export * from "./threads";
export {
  APP_USAGE_HEADER,
  BUSINESS_USE_CASE_USAGE_HEADER,
  type GraphUsage,
  parseUsageHeaders,
  regainAccessDelayMs,
  usageSnapshot,
} from "./usage";
