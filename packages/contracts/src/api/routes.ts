import { z } from "zod";
import { IdSchema } from "../common";
import { ChangePasswordRequestSchema, LoginRequestSchema, MeSchema } from "./auth";
import { CursorPageQuerySchema, cursorPageSchema, listSchema } from "./common";
import {
  ConversationSchema,
  CreateConversationSchema,
  MessageSchema,
  PostMessageRequestSchema,
  PostMessageResponseSchema,
} from "./conversations";
import { DeviceSchema, PairingCodeSchema, PairRequestSchema, PairResponseSchema } from "./devices";
import { JobSummarySchema } from "./jobs";
import {
  CreateProjectSchema,
  ListProjectsQuerySchema,
  ProjectSchema,
  UpdateProjectSchema,
} from "./projects";
import { AccessTokenSchema, CreateTokenRequestSchema, CreateTokenResponseSchema } from "./tokens";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

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

/** Every REST route of the M1 API. The web client and the API both build on this map. */
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
