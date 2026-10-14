import { z } from "zod";
import type { MetaAppConfig, PlatformsConfig } from "../../env";
import { createGraphClient, type GraphClient, type GraphClientOptions } from "./client";
import { MetaGraphError } from "./errors";
import { parseGraph } from "./parse";
import { appAccessToken } from "./proof";

// The Graph API calls of Facebook Login for Business, Pages and Instagram, as confirmed against
// Meta's documentation (Graph API v26.0):
// - login dialog: `https://www.facebook.com/<version>/dialog/oauth` with `client_id`,
//   `redirect_uri`, `state`, `config_id` and `response_type=code`;
// - code exchange: `GET /<version>/oauth/access_token` with `client_id`, `redirect_uri`,
//   `client_secret` and `code`;
// - long-lived token: `GET /<version>/oauth/access_token` with `grant_type=fb_exchange_token`;
// - Pages: `GET /<version>/me/accounts` (each Page carries its own token, which does not expire
//   when the user token is long-lived);
// - token checks: `GET /<version>/debug_token?input_token=` with an app access token;
// - app check: `GET /<version>/oauth/access_token?grant_type=client_credentials`, `GET /<app-id>`.

/** Host of the Facebook login dialog. */
export const META_DIALOG_BASE_URL = "https://www.facebook.com";

/** The permissions the Facebook Login for Business configuration grants (see the runbook). */
export const META_LOGIN_PERMISSIONS = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "read_insights",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
] as const;

/** Most Pages read from one sign-in. */
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
/** Pages of results followed at most, so a misbehaving cursor cannot loop. */
const MAX_PAGINATION_STEPS = 5;

/** The Graph API client of `platforms`, with `appsecret_proof` from the Meta app secret. */
export function createMetaGraphClient(
  platforms: Pick<PlatformsConfig, "metaGraphBaseUrl" | "metaGraphVersion" | "meta">,
  options: Partial<GraphClientOptions> = {},
): GraphClient {
  return createGraphClient({
    baseUrl: platforms.metaGraphBaseUrl,
    version: platforms.metaGraphVersion,
    appSecret: platforms.meta?.appSecret ?? null,
    tokenPlacement: "header",
    ...options,
  });
}

/** The login dialog URL a sign-in starts at. */
export function metaDialogUrl(
  app: MetaAppConfig,
  input: { version: string; redirectUri: string; state: string },
): string {
  const url = new URL(`${META_DIALOG_BASE_URL}/${input.version}/dialog/oauth`);
  url.searchParams.set("client_id", app.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("config_id", app.loginConfigId);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
});
export type MetaTokenResponse = z.infer<typeof TokenResponseSchema>;

/** Exchanges the dialog's `code` for a short-lived user token. Never retried: a code works once. */
export async function exchangeMetaCode(
  client: GraphClient,
  app: MetaAppConfig,
  input: { code: string; redirectUri: string; signal?: AbortSignal },
): Promise<MetaTokenResponse> {
  const response = await client.request({
    path: "/oauth/access_token",
    query: {
      client_id: app.appId,
      redirect_uri: input.redirectUri,
      client_secret: app.appSecret,
      code: input.code,
    },
    retry: false,
    signal: input.signal,
  });
  return parseGraph(TokenResponseSchema, response, "the code exchange");
}

/** Exchanges a short-lived user token for a long-lived one (about 60 days). */
export async function exchangeMetaLongLivedToken(
  client: GraphClient,
  app: MetaAppConfig,
  input: { accessToken: string; signal?: AbortSignal },
): Promise<MetaTokenResponse> {
  const response = await client.request({
    path: "/oauth/access_token",
    query: {
      grant_type: "fb_exchange_token",
      client_id: app.appId,
      client_secret: app.appSecret,
      fb_exchange_token: input.accessToken,
    },
    retry: false,
    signal: input.signal,
  });
  return parseGraph(TokenResponseSchema, response, "the long-lived token exchange");
}

/** A `picture{url}` edge, as Pages return it. */
const PictureEdgeSchema = z.object({ data: z.object({ url: z.string().optional() }).optional() });

const PageSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  access_token: z.string().min(1).optional(),
  picture: PictureEdgeSchema.optional(),
  instagram_business_account: z
    .object({
      id: z.string().min(1),
      username: z.string().optional(),
      profile_picture_url: z.string().optional(),
    })
    .optional(),
});
export type MetaPage = z.infer<typeof PageSchema>;

const PagesResponseSchema = z.object({
  data: z.array(z.unknown()).default([]),
  paging: z
    .object({
      cursors: z.object({ after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});

/** What `listMetaPages` asks for: each Page, its token and picture, and its Instagram account. */
export const META_PAGE_FIELDS =
  "id,name,access_token,picture.type(large){url}," +
  "instagram_business_account{id,username,profile_picture_url}";

/**
 * The Pages the user manages, each with its Page token and linked Instagram professional account,
 * following the `after` cursor (never the `next` URL, which carries the token). Pages without a
 * token (no task that allows posting) are left out.
 */
export async function listMetaPages(
  client: GraphClient,
  input: { accessToken: string; signal?: AbortSignal },
): Promise<MetaPage[]> {
  const pages: MetaPage[] = [];
  let after: string | undefined;
  for (let step = 0; step < MAX_PAGINATION_STEPS && pages.length < MAX_PAGES; step += 1) {
    const response = await client.request({
      path: "/me/accounts",
      query: {
        fields: META_PAGE_FIELDS,
        limit: PAGE_SIZE,
        after,
      },
      accessToken: input.accessToken,
      signal: input.signal,
    });
    const body = parseGraph(PagesResponseSchema, response, "the Page list");
    for (const entry of body.data) {
      const page = PageSchema.safeParse(entry);
      if (page.success && page.data.access_token !== undefined && pages.length < MAX_PAGES) {
        pages.push(page.data);
      }
    }
    after = body.paging?.cursors?.after;
    if (body.paging?.next === undefined || after === undefined) {
      break;
    }
  }
  return pages;
}

const PageAccountPictureSchema = z.object({
  picture: PictureEdgeSchema.optional(),
  profile_picture_url: z.string().optional(),
});

/**
 * The current profile picture address of a Facebook Page or an Instagram professional account,
 * read with the Page token; undefined when the account has none.
 */
export async function getMetaPicture(
  client: GraphClient,
  input: {
    platform: "facebook" | "instagram";
    accountId: string;
    accessToken: string;
    signal?: AbortSignal;
  },
): Promise<string | undefined> {
  const response = await client.request({
    path: `/${encodeURIComponent(input.accountId)}`,
    query: {
      fields: input.platform === "facebook" ? "picture.type(large){url}" : "profile_picture_url",
    },
    accessToken: input.accessToken,
    signal: input.signal,
  });
  const body = parseGraph(PageAccountPictureSchema, response, "the profile picture");
  return input.platform === "facebook" ? body.picture?.data?.url : body.profile_picture_url;
}

const DebugTokenSchema = z.object({
  data: z.object({
    app_id: z.string().optional(),
    type: z.string().optional(),
    is_valid: z.boolean(),
    expires_at: z.number().int().optional(),
    data_access_expires_at: z.number().int().optional(),
    scopes: z.array(z.string()).optional(),
    user_id: z.string().optional(),
    profile_id: z.string().optional(),
    error: z
      .object({
        code: z.number().int().optional(),
        subcode: z.number().int().optional(),
        message: z.string().optional(),
      })
      .optional(),
  }),
});
export type MetaTokenDebug = z.infer<typeof DebugTokenSchema>["data"];

/** Inspects `inputToken` with the app access token: validity, scopes, expiry and owner. */
export async function debugMetaToken(
  client: GraphClient,
  app: Pick<MetaAppConfig, "appId" | "appSecret">,
  input: { inputToken: string; signal?: AbortSignal },
): Promise<MetaTokenDebug> {
  const response = await client.request({
    path: "/debug_token",
    query: { input_token: input.inputToken },
    accessToken: appAccessToken(app.appId, app.appSecret),
    signal: input.signal,
  });
  return parseGraph(DebugTokenSchema, response, "the token check").data;
}

/** An app access token from the app id and secret (`grant_type=client_credentials`). */
export async function metaAppAccessToken(
  client: GraphClient,
  app: Pick<MetaAppConfig, "appId" | "appSecret">,
  signal?: AbortSignal,
): Promise<string> {
  const response = await client.request({
    path: "/oauth/access_token",
    query: {
      client_id: app.appId,
      client_secret: app.appSecret,
      grant_type: "client_credentials",
    },
    signal,
  });
  return parseGraph(TokenResponseSchema, response, "the app token request").access_token;
}

const AppSchema = z.object({ id: z.string().min(1), name: z.string().optional() });

/** The app's own record, read with an app access token. */
export async function getMetaApp(
  client: GraphClient,
  input: { appId: string; accessToken: string; signal?: AbortSignal },
): Promise<z.infer<typeof AppSchema>> {
  const response = await client.request({
    path: `/${encodeURIComponent(input.appId)}`,
    query: { fields: "id,name" },
    accessToken: input.accessToken,
    signal: input.signal,
  });
  return parseGraph(AppSchema, response, "the app record");
}

// Business Discovery: another Instagram professional account's public profile and media, read
// through `GET /<ig-user-id>?fields=business_discovery.username(<handle>){...}` with the token of
// one of the app's own Instagram accounts. Only business and creator accounts answer.

/** Posts asked for per Business Discovery page. */
export const BUSINESS_DISCOVERY_PAGE_SIZE = 50;

/** Subcode of "the user was not found or is not a business or creator account". */
export const BUSINESS_DISCOVERY_NOT_FOUND_SUBCODE = 2_207_013;

const BUSINESS_DISCOVERY_MEDIA_FIELDS = [
  "id",
  "media_type",
  "media_product_type",
  "caption",
  "like_count",
  "comments_count",
  "view_count",
  "timestamp",
  "permalink",
] as const;

const countSchema = z.number().int().min(0).nullable().optional();

const DiscoveredMediaSchema = z.object({
  id: z.string().min(1),
  media_type: z.string().optional(),
  media_product_type: z.string().optional(),
  caption: z.string().optional(),
  like_count: countSchema,
  comments_count: countSchema,
  view_count: countSchema,
  timestamp: z.string().optional(),
  permalink: z.string().optional(),
});

const BusinessDiscoveryResponseSchema = z.object({
  business_discovery: z.object({
    username: z.string().optional(),
    name: z.string().optional(),
    followers_count: countSchema,
    media_count: countSchema,
    media: z
      .object({
        data: z.array(z.unknown()).default([]),
        paging: z
          .object({
            cursors: z.object({ after: z.string().optional() }).optional(),
            next: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  }),
});

/** One post of a discovered account, as far as competitor research reads it. */
export interface DiscoveredMedia {
  id: string;
  mediaType: string | null;
  mediaProductType: string | null;
  caption: string | null;
  likeCount: number | null;
  commentsCount: number | null;
  /** Null when the API did not report views for the post (or refused the field). */
  viewCount: number | null;
  timestamp: string | null;
  permalink: string | null;
}

export interface BusinessDiscoveryResult {
  username: string | null;
  name: string | null;
  followersCount: number | null;
  mediaCount: number | null;
  /** The most recent posts, newest first, at most `maxPosts`. */
  media: DiscoveredMedia[];
  /** False when the API refused `view_count` and the posts were read without it. */
  viewCounts: boolean;
}

/** The `fields` parameter of one Business Discovery page. `handle` must be a checked handle. */
export function businessDiscoveryFields(
  handle: string,
  options: { after?: string | undefined; viewCount: boolean; limit?: number },
): string {
  const fields = BUSINESS_DISCOVERY_MEDIA_FIELDS.filter(
    (field) => options.viewCount || field !== "view_count",
  ).join(",");
  const limit = options.limit ?? BUSINESS_DISCOVERY_PAGE_SIZE;
  const after = options.after === undefined ? "" : `.after(${options.after})`;
  return (
    `business_discovery.username(${handle})` +
    `{username,name,followers_count,media_count,media.limit(${limit})${after}{${fields}}}`
  );
}

/** A cursor goes into the `fields` expression, so only the characters cursors use pass. */
const CURSOR_RE = /^[A-Za-z0-9_=-]{1,500}$/;

/** Whether a failed call refused a field (`view_count`) rather than the account or the token. */
function refusedViewCount(error: unknown): boolean {
  return (
    error instanceof MetaGraphError &&
    error.fields.code === 100 &&
    error.fields.subcode !== BUSINESS_DISCOVERY_NOT_FOUND_SUBCODE
  );
}

function mediaOf(entry: unknown): DiscoveredMedia | null {
  const parsed = DiscoveredMediaSchema.safeParse(entry);
  if (!parsed.success) {
    return null;
  }
  const media = parsed.data;
  return {
    id: media.id,
    mediaType: media.media_type ?? null,
    mediaProductType: media.media_product_type ?? null,
    caption: media.caption ?? null,
    likeCount: media.like_count ?? null,
    commentsCount: media.comments_count ?? null,
    viewCount: media.view_count ?? null,
    timestamp: media.timestamp ?? null,
    permalink: media.permalink ?? null,
  };
}

/**
 * Reads the profile and up to `maxPosts` recent posts of the professional account `handle`, in
 * pages of at most `BUSINESS_DISCOVERY_PAGE_SIZE`, with the token of the app's Instagram account
 * `igUserId`. `handle` must already match `COMPETITOR_HANDLE_RE`: it is part of the `fields`
 * expression. When the API refuses `view_count`, the page is asked for again without it and the
 * remaining pages leave it out. Throws `MetaGraphError`; an unknown or personal account has the
 * subcode `BUSINESS_DISCOVERY_NOT_FOUND_SUBCODE`.
 */
export async function businessDiscovery(
  client: GraphClient,
  input: {
    igUserId: string;
    handle: string;
    accessToken: string;
    maxPosts: number;
    signal?: AbortSignal;
  },
): Promise<BusinessDiscoveryResult> {
  const result: BusinessDiscoveryResult = {
    username: null,
    name: null,
    followersCount: null,
    mediaCount: null,
    media: [],
    viewCounts: true,
  };
  const seen = new Set<string>();
  let after: string | undefined;
  // A page may come back shorter than asked; two extra pages allow for that, and no more, so a
  // cursor that never ends cannot loop.
  const maxSteps = Math.ceil(input.maxPosts / BUSINESS_DISCOVERY_PAGE_SIZE) + 2;
  const page = () =>
    client.request({
      path: `/${encodeURIComponent(input.igUserId)}`,
      query: {
        fields: businessDiscoveryFields(input.handle, {
          after,
          viewCount: result.viewCounts,
          limit: Math.min(BUSINESS_DISCOVERY_PAGE_SIZE, input.maxPosts - result.media.length),
        }),
      },
      accessToken: input.accessToken,
      signal: input.signal,
    });
  for (let step = 0; step < maxSteps && result.media.length < input.maxPosts; step += 1) {
    let response: Awaited<ReturnType<typeof page>>;
    try {
      response = await page();
    } catch (error) {
      if (!result.viewCounts || !refusedViewCount(error)) {
        throw error;
      }
      result.viewCounts = false;
      response = await page();
    }
    const account = parseGraph(
      BusinessDiscoveryResponseSchema,
      response,
      "the account lookup",
    ).business_discovery;
    if (step === 0) {
      result.username = account.username ?? null;
      result.name = account.name ?? null;
      result.followersCount = account.followers_count ?? null;
      result.mediaCount = account.media_count ?? null;
    }
    for (const entry of account.media?.data ?? []) {
      const media = mediaOf(entry);
      if (media !== null && !seen.has(media.id) && result.media.length < input.maxPosts) {
        seen.add(media.id);
        result.media.push(media);
      }
    }
    after = account.media?.paging?.cursors?.after;
    if (after === undefined || !CURSOR_RE.test(after)) {
      break;
    }
  }
  return result;
}
