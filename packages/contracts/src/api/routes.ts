import { z } from "zod";
import { IdSchema } from "../common";
import { SkillNameSchema } from "../pipeline/skills";
import {
  AssetDetailSchema,
  AssetSchema,
  AssetUrlQuerySchema,
  AssetUrlSchema,
  CreateUploadRequestSchema,
  CreateUploadResponseSchema,
  FinalizeAssetRequestSchema,
  ListItemAssetsQuerySchema,
} from "./assets";
import { ChangePasswordRequestSchema, LoginRequestSchema, MeSchema } from "./auth";
import {
  ApprovalsInboxSchema,
  ApprovalsQuerySchema,
  CalendarQuerySchema,
  CalendarResponseSchema,
  CreatePostRequestSchema,
  ReschedulePostRequestSchema,
  ScheduledPostSchema,
} from "./calendar";
import {
  ChannelSchema,
  CreateChannelRequestSchema,
  SeriesChannelsSchema,
  UpdateChannelRequestSchema,
  UpdateSeriesChannelsRequestSchema,
} from "./channels";
import { CursorPageQuerySchema, cursorPageSchema, listSchema } from "./common";
import {
  ContentActionRequestSchema,
  ContentItemDetailSchema,
  ContentItemSchema,
  ContentVersionSchema,
  ContentVersionSummarySchema,
  CreateContentItemRequestSchema,
  EditVersionRequestSchema,
  EditVersionResponseSchema,
  ListContentQuerySchema,
  UpdateContentItemRequestSchema,
} from "./content";
import {
  ConversationSchema,
  CreateConversationSchema,
  MessageSchema,
  PostMessageRequestSchema,
  PostMessageResponseSchema,
} from "./conversations";
import { DeviceSchema, PairingCodeSchema, PairRequestSchema, PairResponseSchema } from "./devices";
import {
  CreateFormatRequestSchema,
  FormatSchema,
  FormatVersionSchema,
  UpdateFormatRequestSchema,
} from "./formats";
import { JobSummarySchema } from "./jobs";
import {
  CaptureConversationSchema,
  CreateKbEntrySchema,
  KbEntryDetailSchema,
  KbEntrySchema,
  KbSearchHitSchema,
  KbSearchQuerySchema,
  KbTagCountSchema,
  ListKbQuerySchema,
  UpdateKbEntrySchema,
} from "./kb";
import {
  CreateProjectSchema,
  ListProjectsQuerySchema,
  ProjectSchema,
  UpdateProjectSchema,
} from "./projects";
import { PublishAttemptSchema, PublisherStatusSchema } from "./publisher";
import {
  CreateReviewRequestSchema,
  CreateReviewResponseSchema,
  ReviewQueueQuerySchema,
  ReviewSchema,
} from "./reviews";
import { ListScheduledTasksQuerySchema, ScheduledTaskSchema } from "./scheduler";
import {
  CreateSeriesRequestSchema,
  ListSeriesQuerySchema,
  SeriesSchema,
  UpdateSeriesRequestSchema,
} from "./series";
import {
  GetSkillQuerySchema,
  SkillSummarySchema,
  SkillVersionDetailSchema,
  SkillVersionSummarySchema,
} from "./skills";
import { AccessTokenSchema, CreateTokenRequestSchema, CreateTokenResponseSchema } from "./tokens";
import {
  InspectPasswordTokenRequestSchema,
  InviteUserRequestSchema,
  InviteUserResponseSchema,
  PasswordTokenInfoSchema,
  ResetLinkResponseSchema,
  SetPasswordRequestSchema,
  UserSummarySchema,
} from "./users";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * `session`: cookie session, plus the CSRF checks on unsafe methods.
 * `none`: public (rate-limited where it matters).
 */
export type RouteAuth = "session" | "none";

export interface RouteDefinition {
  readonly method: HttpMethod;
  /** Hono-style path with `:name` parameters. */
  readonly path: string;
  readonly auth: RouteAuth;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  /** Schema of the success body, or `null` for `204 No Content`. */
  readonly response: z.ZodType | null;
  readonly status: 200 | 201 | 204;
}

function route<const R extends RouteDefinition>(definition: R): R {
  return definition;
}

const IdParamsSchema = z.object({ id: IdSchema });
const ProjectIdParamsSchema = z.object({ projectId: IdSchema });
const IdOrSlugParamsSchema = z.object({ idOrSlug: z.string().min(1).max(64) });
const VersionParamsSchema = z.object({ id: IdSchema, versionId: IdSchema });
const SkillNameParamsSchema = z.object({ name: SkillNameSchema });

/**
 * Every REST route of the API. The web client and the API both build on this map.
 *
 * `kb.search` (`/api/kb/search`) must be registered before the `/api/kb/:id` routes.
 */
export const routes = {
  "auth.login": route({
    method: "POST",
    path: "/api/auth/login",
    auth: "none",
    body: LoginRequestSchema,
    response: MeSchema,
    status: 200,
  }),
  "auth.logout": route({
    method: "POST",
    path: "/api/auth/logout",
    auth: "session",
    response: null,
    status: 204,
  }),
  "auth.me": route({
    method: "GET",
    path: "/api/auth/me",
    auth: "session",
    response: MeSchema,
    status: 200,
  }),
  "auth.changePassword": route({
    method: "POST",
    path: "/api/auth/password",
    auth: "session",
    body: ChangePasswordRequestSchema,
    response: null,
    status: 204,
  }),
  /** Public: shows who a set-password link is for. Unknown, used and expired tokens are 404. */
  "auth.inspectPasswordToken": route({
    method: "POST",
    path: "/api/auth/password-tokens/inspect",
    auth: "none",
    body: InspectPasswordTokenRequestSchema,
    response: PasswordTokenInfoSchema,
    status: 200,
  }),
  /** Public: consumes a set-password link. The user signs in afterwards. */
  "auth.setPassword": route({
    method: "POST",
    path: "/api/auth/set-password",
    auth: "none",
    body: SetPasswordRequestSchema,
    response: null,
    status: 204,
  }),

  /** The user routes are owner-only. */
  "users.list": route({
    method: "GET",
    path: "/api/users",
    auth: "session",
    response: listSchema(UserSummarySchema),
    status: 200,
  }),
  "users.invite": route({
    method: "POST",
    path: "/api/users/invitations",
    auth: "session",
    body: InviteUserRequestSchema,
    response: InviteUserResponseSchema,
    status: 201,
  }),
  "users.resetLink": route({
    method: "POST",
    path: "/api/users/:id/reset-link",
    auth: "session",
    params: IdParamsSchema,
    response: ResetLinkResponseSchema,
    status: 201,
  }),
  "users.disable": route({
    method: "POST",
    path: "/api/users/:id/disable",
    auth: "session",
    params: IdParamsSchema,
    response: UserSummarySchema,
    status: 200,
  }),

  "projects.list": route({
    method: "GET",
    path: "/api/projects",
    auth: "session",
    query: ListProjectsQuerySchema,
    response: listSchema(ProjectSchema),
    status: 200,
  }),
  "projects.create": route({
    method: "POST",
    path: "/api/projects",
    auth: "session",
    body: CreateProjectSchema,
    response: ProjectSchema,
    status: 201,
  }),
  "projects.get": route({
    method: "GET",
    path: "/api/projects/:idOrSlug",
    auth: "session",
    params: IdOrSlugParamsSchema,
    response: ProjectSchema,
    status: 200,
  }),
  "projects.update": route({
    method: "PATCH",
    path: "/api/projects/:idOrSlug",
    auth: "session",
    params: IdOrSlugParamsSchema,
    body: UpdateProjectSchema,
    response: ProjectSchema,
    status: 200,
  }),
  "projects.archive": route({
    method: "POST",
    path: "/api/projects/:id/archive",
    auth: "session",
    params: IdParamsSchema,
    response: ProjectSchema,
    status: 200,
  }),

  "conversations.list": route({
    method: "GET",
    path: "/api/projects/:projectId/conversations",
    auth: "session",
    params: ProjectIdParamsSchema,
    response: listSchema(ConversationSchema),
    status: 200,
  }),
  "conversations.create": route({
    method: "POST",
    path: "/api/projects/:projectId/conversations",
    auth: "session",
    params: ProjectIdParamsSchema,
    body: CreateConversationSchema,
    response: ConversationSchema,
    status: 201,
  }),
  "conversations.get": route({
    method: "GET",
    path: "/api/conversations/:id",
    auth: "session",
    params: IdParamsSchema,
    response: ConversationSchema,
    status: 200,
  }),
  "messages.list": route({
    method: "GET",
    path: "/api/conversations/:id/messages",
    auth: "session",
    params: IdParamsSchema,
    query: CursorPageQuerySchema,
    response: cursorPageSchema(MessageSchema),
    status: 200,
  }),
  "messages.post": route({
    method: "POST",
    path: "/api/conversations/:id/messages",
    auth: "session",
    params: IdParamsSchema,
    body: PostMessageRequestSchema,
    response: PostMessageResponseSchema,
    status: 201,
  }),

  "jobs.get": route({
    method: "GET",
    path: "/api/jobs/:id",
    auth: "session",
    params: IdParamsSchema,
    response: JobSummarySchema,
    status: 200,
  }),
  "jobs.cancel": route({
    method: "POST",
    path: "/api/jobs/:id/cancel",
    auth: "session",
    params: IdParamsSchema,
    response: JobSummarySchema,
    status: 200,
  }),

  "kb.list": route({
    method: "GET",
    path: "/api/projects/:projectId/kb",
    auth: "session",
    params: ProjectIdParamsSchema,
    query: ListKbQuerySchema,
    response: cursorPageSchema(KbEntrySchema),
    status: 200,
  }),
  "kb.create": route({
    method: "POST",
    path: "/api/projects/:projectId/kb",
    auth: "session",
    params: ProjectIdParamsSchema,
    body: CreateKbEntrySchema,
    response: KbEntryDetailSchema,
    status: 201,
  }),
  "kb.capture": route({
    method: "POST",
    path: "/api/projects/:projectId/kb/capture",
    auth: "session",
    params: ProjectIdParamsSchema,
    body: CaptureConversationSchema,
    response: KbEntryDetailSchema,
    status: 201,
  }),
  "kb.tags": route({
    method: "GET",
    path: "/api/projects/:projectId/kb/tags",
    auth: "session",
    params: ProjectIdParamsSchema,
    response: listSchema(KbTagCountSchema),
    status: 200,
  }),
  "kb.search": route({
    method: "GET",
    path: "/api/kb/search",
    auth: "session",
    query: KbSearchQuerySchema,
    response: listSchema(KbSearchHitSchema),
    status: 200,
  }),
  "kb.get": route({
    method: "GET",
    path: "/api/kb/:id",
    auth: "session",
    params: IdParamsSchema,
    response: KbEntryDetailSchema,
    status: 200,
  }),
  /** `409 conflict` when `expectedUpdatedAt` is not the entry's current `updatedAt`. */
  "kb.update": route({
    method: "PATCH",
    path: "/api/kb/:id",
    auth: "session",
    params: IdParamsSchema,
    body: UpdateKbEntrySchema,
    response: KbEntryDetailSchema,
    status: 200,
  }),
  "kb.delete": route({
    method: "DELETE",
    path: "/api/kb/:id",
    auth: "session",
    params: IdParamsSchema,
    response: null,
    status: 204,
  }),
  /** Queues `kb.analyze_reference` for a reference that has a transcript or uploaded media. */
  "kb.analyze": route({
    method: "POST",
    path: "/api/kb/:id/analyze",
    auth: "session",
    params: IdParamsSchema,
    response: JobSummarySchema,
    status: 201,
  }),

  "formats.list": route({
    method: "GET",
    path: "/api/projects/:projectId/formats",
    auth: "session",
    params: ProjectIdParamsSchema,
    response: listSchema(FormatSchema),
    status: 200,
  }),
  "formats.create": route({
    method: "POST",
    path: "/api/projects/:projectId/formats",
    auth: "session",
    params: ProjectIdParamsSchema,
    body: CreateFormatRequestSchema,
    response: FormatSchema,
    status: 201,
  }),
  "formats.get": route({
    method: "GET",
    path: "/api/formats/:id",
    auth: "session",
    params: IdParamsSchema,
    response: FormatSchema,
    status: 200,
  }),
  /** Stores a new version. `409 conflict` when `baseVersionId` is not the current version. */
  "formats.update": route({
    method: "PATCH",
    path: "/api/formats/:id",
    auth: "session",
    params: IdParamsSchema,
    body: UpdateFormatRequestSchema,
    response: FormatSchema,
    status: 200,
  }),
  /** Every version, newest first. */
  "formats.versions": route({
    method: "GET",
    path: "/api/formats/:id/versions",
    auth: "session",
    params: IdParamsSchema,
    response: listSchema(FormatVersionSchema),
    status: 200,
  }),

  "series.list": route({
    method: "GET",
    path: "/api/projects/:projectId/series",
    auth: "session",
    params: ProjectIdParamsSchema,
    query: ListSeriesQuerySchema,
    response: listSchema(SeriesSchema),
    status: 200,
  }),
  "series.create": route({
    method: "POST",
    path: "/api/projects/:projectId/series",
    auth: "session",
    params: ProjectIdParamsSchema,
    body: CreateSeriesRequestSchema,
    response: SeriesSchema,
    status: 201,
  }),
  "series.get": route({
    method: "GET",
    path: "/api/series/:id",
    auth: "session",
    params: IdParamsSchema,
    response: SeriesSchema,
    status: 200,
  }),
  "series.update": route({
    method: "PATCH",
    path: "/api/series/:id",
    auth: "session",
    params: IdParamsSchema,
    body: UpdateSeriesRequestSchema,
    response: SeriesSchema,
    status: 200,
  }),
  "series.pause": route({
    method: "POST",
    path: "/api/series/:id/pause",
    auth: "session",
    params: IdParamsSchema,
    response: SeriesSchema,
    status: 200,
  }),
  "series.resume": route({
    method: "POST",
    path: "/api/series/:id/resume",
    auth: "session",
    params: IdParamsSchema,
    response: SeriesSchema,
    status: 200,
  }),
  "series.archive": route({
    method: "POST",
    path: "/api/series/:id/archive",
    auth: "session",
    params: IdParamsSchema,
    response: SeriesSchema,
    status: 200,
  }),

  /** The series' channels, enabled or not. */
  "series.channels": route({
    method: "GET",
    path: "/api/series/:id/channels",
    auth: "session",
    params: IdParamsSchema,
    response: SeriesChannelsSchema,
    status: 200,
  }),
  /** Replaces the series' channel links; channels left out are unlinked. */
  "series.setChannels": route({
    method: "PUT",
    path: "/api/series/:id/channels",
    auth: "session",
    params: IdParamsSchema,
    body: UpdateSeriesChannelsRequestSchema,
    response: SeriesChannelsSchema,
    status: 200,
  }),

  "content.list": route({
    method: "GET",
    path: "/api/content",
    auth: "session",
    query: ListContentQuerySchema,
    response: cursorPageSchema(ContentItemSchema),
    status: 200,
  }),
  "content.create": route({
    method: "POST",
    path: "/api/projects/:projectId/content",
    auth: "session",
    params: ProjectIdParamsSchema,
    body: CreateContentItemRequestSchema,
    response: ContentItemDetailSchema,
    status: 201,
  }),
  "content.get": route({
    method: "GET",
    path: "/api/content/:id",
    auth: "session",
    params: IdParamsSchema,
    response: ContentItemDetailSchema,
    status: 200,
  }),
  "content.update": route({
    method: "PATCH",
    path: "/api/content/:id",
    auth: "session",
    params: IdParamsSchema,
    body: UpdateContentItemRequestSchema,
    response: ContentItemSchema,
    status: 200,
  }),
  /** Every version, newest first. */
  "content.versions.list": route({
    method: "GET",
    path: "/api/content/:id/versions",
    auth: "session",
    params: IdParamsSchema,
    response: listSchema(ContentVersionSummarySchema),
    status: 200,
  }),
  "content.versions.get": route({
    method: "GET",
    path: "/api/content/:id/versions/:versionId",
    auth: "session",
    params: VersionParamsSchema,
    response: ContentVersionSchema,
    status: 200,
  }),
  /** `409 conflict` when `baseVersionId` is stale; `409 invalid_transition` when refused. */
  "content.versions.edit": route({
    method: "POST",
    path: "/api/content/:id/versions",
    auth: "session",
    params: IdParamsSchema,
    body: EditVersionRequestSchema,
    response: EditVersionResponseSchema,
    status: 201,
  }),
  /** Starts production work and returns its job. */
  "content.actions": route({
    method: "POST",
    path: "/api/content/:id/actions",
    auth: "session",
    params: IdParamsSchema,
    body: ContentActionRequestSchema,
    response: JobSummarySchema,
    status: 201,
  }),
  "content.archive": route({
    method: "POST",
    path: "/api/content/:id/archive",
    auth: "session",
    params: IdParamsSchema,
    response: ContentItemSchema,
    status: 200,
  }),
  /** Brings an archived item back as an idea. */
  "content.restore": route({
    method: "POST",
    path: "/api/content/:id/restore",
    auth: "session",
    params: IdParamsSchema,
    response: ContentItemSchema,
    status: 200,
  }),
  /** The item's producer conversation, created on first use. */
  "content.conversation": route({
    method: "POST",
    path: "/api/content/:id/conversation",
    auth: "session",
    params: IdParamsSchema,
    response: ConversationSchema,
    status: 200,
  }),
  /** The item's assets, newest first, such as every voice take. */
  "content.assets": route({
    method: "GET",
    path: "/api/content/:id/assets",
    auth: "session",
    params: IdParamsSchema,
    query: ListItemAssetsQuerySchema,
    response: listSchema(AssetSchema),
    status: 200,
  }),

  "reviews.create": route({
    method: "POST",
    path: "/api/content/:id/reviews",
    auth: "session",
    params: IdParamsSchema,
    body: CreateReviewRequestSchema,
    response: CreateReviewResponseSchema,
    status: 201,
  }),
  /** The item's reviews, newest first. */
  "reviews.list": route({
    method: "GET",
    path: "/api/content/:id/reviews",
    auth: "session",
    params: IdParamsSchema,
    response: listSchema(ReviewSchema),
    status: 200,
  }),
  "reviews.queue": route({
    method: "GET",
    path: "/api/reviews/queue",
    auth: "session",
    query: ReviewQueueQuerySchema,
    response: cursorPageSchema(ContentItemSchema),
    status: 200,
  }),

  /** Answers `upload: null` when a ready asset with the same kind and SHA-256 already exists. */
  "assets.createUpload": route({
    method: "POST",
    path: "/api/assets/uploads",
    auth: "session",
    body: CreateUploadRequestSchema,
    response: CreateUploadResponseSchema,
    status: 201,
  }),
  "assets.finalize": route({
    method: "POST",
    path: "/api/assets/:id/finalize",
    auth: "session",
    params: IdParamsSchema,
    body: FinalizeAssetRequestSchema,
    response: AssetSchema,
    status: 200,
  }),
  "assets.get": route({
    method: "GET",
    path: "/api/assets/:id",
    auth: "session",
    params: IdParamsSchema,
    response: AssetDetailSchema,
    status: 200,
  }),
  /** A presigned GET URL for a ready asset. */
  "assets.url": route({
    method: "GET",
    path: "/api/assets/:id/url",
    auth: "session",
    params: IdParamsSchema,
    query: AssetUrlQuerySchema,
    response: AssetUrlSchema,
    status: 200,
  }),

  "skills.list": route({
    method: "GET",
    path: "/api/skills",
    auth: "session",
    response: listSchema(SkillSummarySchema),
    status: 200,
  }),
  "skills.get": route({
    method: "GET",
    path: "/api/skills/:name",
    auth: "session",
    params: SkillNameParamsSchema,
    query: GetSkillQuerySchema,
    response: SkillVersionDetailSchema,
    status: 200,
  }),
  /** Every published version, newest first. */
  "skills.versions": route({
    method: "GET",
    path: "/api/skills/:name/versions",
    auth: "session",
    params: SkillNameParamsSchema,
    response: listSchema(SkillVersionSummarySchema),
    status: 200,
  }),

  "channels.list": route({
    method: "GET",
    path: "/api/channels",
    auth: "session",
    response: listSchema(ChannelSchema),
    status: 200,
  }),
  /** Adds a planning channel: disconnected, dry-run on. */
  "channels.create": route({
    method: "POST",
    path: "/api/channels",
    auth: "session",
    body: CreateChannelRequestSchema,
    response: ChannelSchema,
    status: 201,
  }),
  /** `409 dry_run_locked` when `dryRun: false` is not allowed yet. */
  "channels.update": route({
    method: "PATCH",
    path: "/api/channels/:id",
    auth: "session",
    params: IdParamsSchema,
    body: UpdateChannelRequestSchema,
    response: ChannelSchema,
    status: 200,
  }),

  /** Posts and open cadence slots in a range of at most 62 days. */
  "calendar.get": route({
    method: "GET",
    path: "/api/calendar",
    auth: "session",
    query: CalendarQuerySchema,
    response: CalendarResponseSchema,
    status: 200,
  }),
  /** Schedules an approved item on a channel as a `queued` post. */
  "scheduledPosts.create": route({
    method: "POST",
    path: "/api/scheduled-posts",
    auth: "session",
    body: CreatePostRequestSchema,
    response: ScheduledPostSchema,
    status: 201,
  }),
  /** `409 conflict` when `expectedUpdatedAt` is stale; `409 post_not_editable` once publishing. */
  "scheduledPosts.reschedule": route({
    method: "PATCH",
    path: "/api/scheduled-posts/:id",
    auth: "session",
    params: IdParamsSchema,
    body: ReschedulePostRequestSchema,
    response: ScheduledPostSchema,
    status: 200,
  }),
  "scheduledPosts.cancel": route({
    method: "POST",
    path: "/api/scheduled-posts/:id/cancel",
    auth: "session",
    params: IdParamsSchema,
    response: ScheduledPostSchema,
    status: 200,
  }),
  /** Every publish attempt of a post, newest first. */
  "scheduledPosts.attempts": route({
    method: "GET",
    path: "/api/scheduled-posts/:id/attempts",
    auth: "session",
    params: IdParamsSchema,
    response: listSchema(PublishAttemptSchema),
    status: 200,
  }),
  /** Items waiting for approval with their slot deadlines, and missed posts. */
  "approvals.inbox": route({
    method: "GET",
    path: "/api/approvals",
    auth: "session",
    query: ApprovalsQuerySchema,
    response: ApprovalsInboxSchema,
    status: 200,
  }),
  "publisher.status": route({
    method: "GET",
    path: "/api/publisher/status",
    auth: "session",
    response: PublisherStatusSchema,
    status: 200,
  }),
  /** Owner and admins only. */
  "scheduler.tasks": route({
    method: "GET",
    path: "/api/scheduler/tasks",
    auth: "session",
    query: ListScheduledTasksQuerySchema,
    response: cursorPageSchema(ScheduledTaskSchema),
    status: 200,
  }),
  /**
   * Owner and admins only. Runs a `failed` or `dead` task again now, with a fresh set of attempts;
   * `409 conflict` for any other status.
   */
  "scheduler.retryTask": route({
    method: "POST",
    path: "/api/scheduler/tasks/:id/retry",
    auth: "session",
    params: IdParamsSchema,
    response: ScheduledTaskSchema,
    status: 200,
  }),

  "devices.list": route({
    method: "GET",
    path: "/api/devices",
    auth: "session",
    response: listSchema(DeviceSchema),
    status: 200,
  }),
  "devices.createPairingCode": route({
    method: "POST",
    path: "/api/devices/pairing-codes",
    auth: "session",
    response: PairingCodeSchema,
    status: 201,
  }),
  "devices.revoke": route({
    method: "DELETE",
    path: "/api/devices/:id",
    auth: "session",
    params: IdParamsSchema,
    response: null,
    status: 204,
  }),
  "bridge.pair": route({
    method: "POST",
    path: "/api/bridge/pair",
    auth: "none",
    body: PairRequestSchema,
    response: PairResponseSchema,
    status: 201,
  }),

  "tokens.list": route({
    method: "GET",
    path: "/api/tokens",
    auth: "session",
    response: listSchema(AccessTokenSchema),
    status: 200,
  }),
  "tokens.create": route({
    method: "POST",
    path: "/api/tokens",
    auth: "session",
    body: CreateTokenRequestSchema,
    response: CreateTokenResponseSchema,
    status: 201,
  }),
  "tokens.revoke": route({
    method: "DELETE",
    path: "/api/tokens/:id",
    auth: "session",
    params: IdParamsSchema,
    response: null,
    status: 204,
  }),
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;

type SchemaInput<S> = S extends z.ZodType ? z.input<S> : undefined;
type SchemaOutput<S> = S extends z.ZodType ? z.output<S> : undefined;

/** What a client sends as the body of route `N`. */
export type RouteBody<N extends RouteName> = SchemaInput<
  Routes[N] extends { body: infer B } ? B : undefined
>;
/** What a client sends as the query of route `N`. */
export type RouteQuery<N extends RouteName> = SchemaInput<
  Routes[N] extends { query: infer Q } ? Q : undefined
>;
/** The parsed success body of route `N`; `undefined` for `204 No Content`. */
export type RouteResponse<N extends RouteName> = SchemaOutput<Routes[N]["response"]>;

type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

/** The `:name` parameters of a path template, as an object type. */
export type PathParams<P extends string> = { [K in PathParamNames<P>]: string };

/** Fills a path template: `buildPath("/api/jobs/:id", {id})`. Values are URI-encoded. */
export function buildPath<P extends string>(path: P, params: PathParams<P>): string {
  const values: Record<string, string> = params;
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for ${path}`);
    }
    return encodeURIComponent(value);
  });
}
