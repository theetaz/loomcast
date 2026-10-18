import { z } from "zod";

// Enumerations shared by the database, API, web app and studio agent. The value arrays are the
// single source of truth: `@loomcast/db` builds its pg enums from them. Values are added together
// with a migration and never removed or renamed in place.

export const USER_ROLES = ["owner", "admin"] as const;
export const UserRoleSchema = z.enum(USER_ROLES);
export type UserRole = (typeof USER_ROLES)[number];

/**
 * `mcp`: a user's MCP token. `device`: a studio agent's bridge token. `job`: a short-lived MCP
 * token minted for one job and handed to its producer session in `job.assign`. `api`: an API
 * client's key for the machine API (`/api/v1`), bound to one project and granted channels.
 */
export const TOKEN_KINDS = ["mcp", "device", "job", "api"] as const;
export const TokenKindSchema = z.enum(TOKEN_KINDS);
export type TokenKind = (typeof TOKEN_KINDS)[number];

export const TOKEN_SCOPES = ["mcp:read", "mcp:write", "mcp:admin", "bridge"] as const;
export const TokenScopeSchema = z.enum(TOKEN_SCOPES);
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Scopes an MCP token may carry. `mcp:admin` is reserved for the owner. */
export const MCP_TOKEN_SCOPES = [
  "mcp:read",
  "mcp:write",
  "mcp:admin",
] as const satisfies readonly TokenScope[];
export const McpTokenScopeSchema = z.enum(MCP_TOKEN_SCOPES);
export type McpTokenScope = (typeof MCP_TOKEN_SCOPES)[number];

/**
 * What an API client may do on one channel. The levels are cumulative:
 * - `read`: see the channel and its posts' status, permalinks, errors and metrics.
 * - `write`: also create and schedule posts; they wait for the owner's approval.
 * - `publish`: also have its posts approved on the owner's behalf and scheduled straight away.
 */
export const API_CHANNEL_ACCESS = ["read", "write", "publish"] as const;
export const ApiChannelAccessSchema = z.enum(API_CHANNEL_ACCESS);
export type ApiChannelAccess = (typeof API_CHANNEL_ACCESS)[number];

/** Whether `granted` includes `required`, as the levels are cumulative. */
export function accessIncludes(granted: ApiChannelAccess, required: ApiChannelAccess): boolean {
  return API_CHANNEL_ACCESS.indexOf(granted) >= API_CHANNEL_ACCESS.indexOf(required);
}

export const PROJECT_STATUSES = ["active", "archived"] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * Fixed allow-list of job types. A value is added only together with a migration and an entry in
 * the job registry (`jobRegistry`).
 */
export const JOB_TYPES = [
  "system.ping",
  "producer.chat",
  "kb.analyze_reference",
  "kb.competitor_report",
  "content.write_script",
  "content.storyboard",
  "content.revise",
  "content.voice",
  "content.render",
  "skills.sync",
] as const;
export const JobTypeSchema = z.enum(JOB_TYPES);
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "queued",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Job statuses after which a job never changes again. */
export const TERMINAL_JOB_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly JobStatus[];

export const MESSAGE_ROLES = ["user", "assistant", "system", "event"] as const;
export const MessageRoleSchema = z.enum(MESSAGE_ROLES);
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const ACTOR_KINDS = ["user", "device", "token", "system"] as const;
export const ActorKindSchema = z.enum(ACTOR_KINDS);
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Kinds of knowledge-base entries. `session_summary` entries are written only through MCP. */
export const KB_ENTRY_KINDS = [
  "brainstorm",
  "reference",
  "decision",
  "note",
  "session_summary",
] as const;
export const KbEntryKindSchema = z.enum(KB_ENTRY_KINDS);
export type KbEntryKind = (typeof KB_ENTRY_KINDS)[number];

/**
 * How a knowledge-base entry was written: in the web app, by an MCP client, by a producer session
 * running a job, or by the optional session-end hook.
 */
export const KB_CREATED_VIA = ["ui", "mcp", "producer", "hook"] as const;
export const KbCreatedViaSchema = z.enum(KB_CREATED_VIA);
export type KbCreatedVia = (typeof KB_CREATED_VIA)[number];

/** Platforms a reference link can point at. Anything unrecognised is `other`. */
export const REFERENCE_PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "threads",
  "x",
  "facebook",
  "other",
] as const;
export const ReferencePlatformSchema = z.enum(REFERENCE_PLATFORMS);
export type ReferencePlatform = (typeof REFERENCE_PLATFORMS)[number];

/**
 * Platforms a competitor can be followed on. Instagram professional accounts are discovered through
 * the official Business Discovery API; Facebook Pages and Threads profiles take pasted video links.
 */
export const COMPETITOR_PLATFORMS = ["instagram", "facebook", "threads"] as const;
export const CompetitorPlatformSchema = z.enum(COMPETITOR_PLATFORMS);
export type CompetitorPlatform = (typeof COMPETITOR_PLATFORMS)[number];

/**
 * A competitor scan:
 * - `analyzing`: each picked video has a `kb.analyze_reference` job on its way;
 * - `reporting`: the analyses are in and `kb.competitor_report` is writing the report;
 * - `done`: the report is in the knowledge base and every video was analysed;
 * - `partial`: the report is in, but some videos could not be analysed;
 * - `failed`: no video could be analysed, or the report failed;
 * - `cancelled`: a user stopped it.
 */
export const COMPETITOR_SCAN_STATUSES = [
  "analyzing",
  "reporting",
  "done",
  "partial",
  "failed",
  "cancelled",
] as const;
export const CompetitorScanStatusSchema = z.enum(COMPETITOR_SCAN_STATUSES);
export type CompetitorScanStatus = (typeof COMPETITOR_SCAN_STATUSES)[number];

/** Scans that still have work on its way. */
export const ACTIVE_COMPETITOR_SCAN_STATUSES = [
  "analyzing",
  "reporting",
] as const satisfies readonly CompetitorScanStatus[];

/**
 * Where a scan's videos came from: the official API ranked by views (`official_api`), or links the
 * user pasted (`links`).
 */
export const COMPETITOR_SCAN_SOURCES = ["official_api", "links"] as const;
export const CompetitorScanSourceSchema = z.enum(COMPETITOR_SCAN_SOURCES);
export type CompetitorScanSource = (typeof COMPETITOR_SCAN_SOURCES)[number];

/** Progress of a reference's `kb.analyze_reference` job, as stored on the reference. */
export const REFERENCE_ANALYSIS_STATUSES = ["none", "queued", "running", "done", "failed"] as const;
export const ReferenceAnalysisStatusSchema = z.enum(REFERENCE_ANALYSIS_STATUSES);
export type ReferenceAnalysisStatus = (typeof REFERENCE_ANALYSIS_STATUSES)[number];

/** What a one-time set-password link was issued for. */
export const PASSWORD_TOKEN_PURPOSES = ["invite", "reset"] as const;
export const PasswordTokenPurposeSchema = z.enum(PASSWORD_TOKEN_PURPOSES);
export type PasswordTokenPurpose = (typeof PASSWORD_TOKEN_PURPOSES)[number];

/**
 * States of a content item. The production stages run `idea` to `render`; `review` waits for a
 * user's decision; `approved`, `scheduled` and `published` follow; `archived` sits outside the flow
 * and can be restored to `idea`. `PIPELINE_TRANSITIONS` says who may move an item between them.
 */
export const PIPELINE_STATES = [
  "idea",
  "script",
  "storyboard",
  "voice",
  "render",
  "review",
  "approved",
  "scheduled",
  "published",
  "archived",
] as const;
export const PipelineStateSchema = z.enum(PIPELINE_STATES);
export type PipelineState = (typeof PIPELINE_STATES)[number];

/** The production stages, in order. Each one is reached by adding one artifact to a version. */
export const PRODUCTION_STATES = [
  "idea",
  "script",
  "storyboard",
  "voice",
  "render",
] as const satisfies readonly PipelineState[];
export const ProductionStateSchema = z.enum(PRODUCTION_STATES);
export type ProductionState = (typeof PRODUCTION_STATES)[number];

/**
 * Production work a user (or autopilot) can start on an item. Each of the first five runs one job;
 * `produce` runs the missing steps one after another, up to a target state.
 */
export const CONTENT_ACTIONS = [
  "write_script",
  "storyboard",
  "voice",
  "render",
  "revise",
  "produce",
] as const;
export const ContentActionSchema = z.enum(CONTENT_ACTIONS);
export type ContentAction = (typeof CONTENT_ACTIONS)[number];

/**
 * How a content version was written: in the web app, through an MCP tool, from a job result, by
 * the server itself (for example the first, empty version of a new item), or by an API client.
 */
export const VERSION_CREATED_VIA = ["ui", "mcp", "job", "system", "api"] as const;
export const VersionCreatedViaSchema = z.enum(VERSION_CREATED_VIA);
export type VersionCreatedVia = (typeof VERSION_CREATED_VIA)[number];

/**
 * How a content item was created: in the web app, by an MCP client with a user token, by a
 * producer session with a job token, by the server (for example a scheduler), or by an API client
 * through the machine API.
 */
export const CONTENT_CREATED_VIA = ["ui", "mcp", "producer", "system", "api"] as const;
export const ContentCreatedViaSchema = z.enum(CONTENT_CREATED_VIA);
export type ContentCreatedVia = (typeof CONTENT_CREATED_VIA)[number];

/** A series either feeds the calendar, is paused, or is archived. */
export const SERIES_STATUSES = ["active", "paused", "archived"] as const;
export const SeriesStatusSchema = z.enum(SERIES_STATUSES);
export type SeriesStatus = (typeof SERIES_STATUSES)[number];

/**
 * Whether approved items publish on their own or wait for each approval. A series sets it in its
 * format rules; a channel that requires approval overrides `auto` (`effectivePublishMode`).
 */
export const PUBLISH_MODES = ["auto", "approval"] as const;
export const PublishModeSchema = z.enum(PUBLISH_MODES);
export type PublishMode = (typeof PUBLISH_MODES)[number];

/**
 * Platforms a channel publishes to: Facebook Pages, Instagram professional accounts and Threads.
 * `x` stays behind a feature flag until its adapter ships. `PLATFORM_FORMATS` says which post
 * formats each one publishes.
 */
export const PLATFORMS = ["facebook", "instagram", "threads", "x"] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = (typeof PLATFORMS)[number];

/**
 * What kind of post a version publishes as:
 * - `reel`: a vertical short video (Instagram and Facebook Reels, a Threads or X video).
 * - `video`: a regular video post (a Facebook Page video).
 * - `image`: one photo.
 * - `carousel`: 2 to 10 photos or videos in one post (a Facebook multi-photo post takes photos).
 * - `story`: one photo or video shown for 24 hours.
 * - `text`: words only, optionally with a link (a Facebook Page post).
 * Studio videos are `reel`s; the other formats are composed from uploaded `media` assets.
 */
export const POST_FORMATS = ["reel", "video", "image", "carousel", "story", "text"] as const;
export const PostFormatSchema = z.enum(POST_FORMATS);
export type PostFormat = (typeof POST_FORMATS)[number];

/**
 * Accounts a channel is connected through:
 * - `meta`: Facebook Login for Business. One sign-in connects Facebook Pages and the Instagram
 *   professional accounts linked to them.
 * - `threads`: Threads profiles, through the Threads API's own sign-in.
 * - `x`: X profiles, behind the `xPublishing` feature flag.
 */
export const OAUTH_PROVIDERS = ["meta", "threads", "x"] as const;
export const OAuthProviderSchema = z.enum(OAUTH_PROVIDERS);
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/**
 * - `disconnected`: no stored credentials, such as a planning channel; it can only dry-run.
 * - `active`: connected and usable.
 * - `needs_reauth`: the platform refused the stored credentials; the owner has to reconnect.
 * - `disabled`: switched off; nothing is planned or published for it.
 */
export const CHANNEL_STATUSES = ["disconnected", "active", "needs_reauth", "disabled"] as const;
export const ChannelStatusSchema = z.enum(CHANNEL_STATUSES);
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/**
 * A post of one item on one channel:
 * - `planned`: a cadence slot holds it; the item is not approved yet.
 * - `queued`: the item is approved and the post waits for its time.
 * - `publishing`: the publisher is sending it, or waits for the platform to finish processing.
 * - `published`: live (or recorded, in dry-run), with a permalink.
 * - `failed`: the publisher gave up; `lastError` says why.
 * - `cancelled`: withdrawn by a user or by replanning.
 * - `missed`: its time came while it was still `planned`.
 */
export const POST_STATUSES = [
  "planned",
  "queued",
  "publishing",
  "published",
  "failed",
  "cancelled",
  "missed",
] as const;
export const PostStatusSchema = z.enum(POST_STATUSES);
export type PostStatus = (typeof POST_STATUSES)[number];

/** Posts that wait for their time; the calendar and the publisher act on these. */
export const OPEN_POST_STATUSES = ["planned", "queued"] as const satisfies readonly PostStatus[];

/** Posts a user may move to another time. Publishing, published and cancelled posts stay put. */
export const RESCHEDULABLE_POST_STATUSES = [
  "planned",
  "queued",
  "failed",
  "missed",
] as const satisfies readonly PostStatus[];

/**
 * A scheduled task's lifecycle:
 * - `pending`: waits for `runAt`; a retry after a failed run is pending again.
 * - `running`: claimed by a scheduler under a lease.
 * - `succeeded`: done.
 * - `failed`: the handler gave up with an error that a retry cannot fix.
 * - `dead`: every attempt failed; it waits in the dead-letter list for a manual retry.
 */
export const TASK_STATUSES = ["pending", "running", "succeeded", "failed", "dead"] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Task statuses after which a task runs again only when an admin retries it. */
export const TERMINAL_TASK_STATUSES = [
  "succeeded",
  "failed",
  "dead",
] as const satisfies readonly TaskStatus[];

/**
 * Whether the publisher sends posts to the platforms (`live`) or only records the exact request it
 * would send (`dry-run`). Matches the server's `PUBLISHING_MODE` setting.
 */
export const PUBLISHING_MODES = ["dry-run", "live"] as const;
export const PublishingModeSchema = z.enum(PUBLISHING_MODES);
export type PublishingMode = (typeof PUBLISHING_MODES)[number];

/**
 * What a stored file is for. `reference_media` is a reference video or audio the user uploaded;
 * `media` is a photo or video a post publishes (the items of an image, carousel or story post).
 */
export const ASSET_KINDS = [
  "voice",
  "render",
  "poster",
  "frame",
  "reference_media",
  "other",
  "media",
] as const;
export const AssetKindSchema = z.enum(ASSET_KINDS);
export type AssetKind = (typeof ASSET_KINDS)[number];

/** `pending` until the upload is finalized and its checksum verified; `failed` on a mismatch. */
export const ASSET_STATUSES = ["pending", "ready", "failed"] as const;
export const AssetStatusSchema = z.enum(ASSET_STATUSES);
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const REVIEW_DECISIONS = ["approve", "request_changes", "reject"] as const;
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** A `skill` teaches one step; a `recipe` strings steps together for one kind of video. */
export const SKILL_KINDS = ["skill", "recipe"] as const;
export const SkillKindSchema = z.enum(SKILL_KINDS);
export type SkillKind = (typeof SKILL_KINDS)[number];
