import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { type OAuthProvider, OAuthProviderSchema, type Platform, PlatformSchema } from "../enums";
import { PlatformAccountIdSchema } from "../publishing/request";
import {
  CHANNEL_NAME_MAX_LENGTH,
  CHANNEL_USERNAME_MAX_LENGTH,
  ChannelSchema,
  PicturePathSchema,
} from "./channels";

// Connecting channels: the browser navigates to `oauth.start`, signs in on the platform, and comes
// back through `oauth.callback`. The server keeps the tokens encrypted in a pending connection and
// redirects to the connect page (`OAUTH_CONNECT_PAGE_PATH`), which lists the accounts the sign-in
// can publish as (`oauth.connection`) and connects the chosen ones (`oauth.accept`). Tokens never
// leave the server: none of these shapes has a field for them, and parsing drops unknown fields.

/** The platforms each provider's sign-in connects. */
export const OAUTH_PROVIDER_PLATFORMS = {
  meta: ["facebook", "instagram"],
  threads: ["threads"],
  x: ["x"],
} as const satisfies Record<OAuthProvider, readonly Platform[]>;

/** The provider a channel of `platform` (re)connects through, such as for a Reconnect button. */
export function oauthProviderForPlatform(platform: Platform): OAuthProvider {
  switch (platform) {
    case "facebook":
    case "instagram":
      return "meta";
    case "threads":
      return "threads";
    case "x":
      return "x";
  }
}

/** A pending connection lasts this long after the callback; then the user signs in again. */
export const OAUTH_CONNECTION_TTL_MS = 30 * 60_000;

/** A sign-in started by `oauth.start` must come back within this time. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** Most accounts one sign-in may offer. */
export const MAX_CONNECTION_ACCOUNTS = 100;

export const CANDIDATE_ACCOUNT_ID_MAX_LENGTH = 256;
export const OAUTH_REDIRECT_TO_MAX_LENGTH = 512;

/** Identifies an account within one pending connection. Build it with `candidateAccountId`. */
export const CandidateAccountIdSchema = z.string().min(1).max(CANDIDATE_ACCOUNT_ID_MAX_LENGTH);

/** The id of the account `externalId` on `platform` within a pending connection. */
export function candidateAccountId(platform: Platform, externalId: string): string {
  return `${platform}:${externalId}`;
}

/** The path of a pending connection's account picture (`oauth.connectionPicture`). */
export function connectionPicturePath(connectionId: string, accountId: string): string {
  return `/api/oauth/connections/${connectionId}/accounts/${encodeURIComponent(accountId)}/picture`;
}

/**
 * An account a sign-in can publish as.
 * - `name` is the Page or profile name, cut to `CHANNEL_NAME_MAX_LENGTH` by the server; it becomes
 *   the channel's `displayName`.
 * - `parentId` is the candidate this account publishes through: an Instagram account's Facebook
 *   Page. Accepting the account connects that Page too, because the Page holds the token.
 * - `alreadyConnected` is true when a channel of the same platform and `externalId` exists;
 *   accepting it again refreshes that channel's credentials instead of adding a channel.
 * - `pictureUrl` is the account's profile picture through the API (`oauth.connectionPicture`),
 *   when the platform gave one.
 */
export const CandidateAccountSchema = z.object({
  id: CandidateAccountIdSchema,
  platform: PlatformSchema,
  externalId: PlatformAccountIdSchema,
  name: z.string().min(1).max(CHANNEL_NAME_MAX_LENGTH),
  username: z.string().min(1).max(CHANNEL_USERNAME_MAX_LENGTH).optional(),
  parentId: CandidateAccountIdSchema.nullable(),
  alreadyConnected: z.boolean(),
  pictureUrl: PicturePathSchema.nullable().optional(),
});
export type CandidateAccount = z.infer<typeof CandidateAccountSchema>;

/**
 * `GET /api/oauth/connections/:id`: the accounts of a pending connection, without any credentials.
 * Ids do not repeat, every `parentId` names another account of the list, and every account is on a
 * platform of the provider (`OAUTH_PROVIDER_PLATFORMS`). An expired or used connection answers
 * `410 connection_expired`.
 */
export const ConnectionCandidatesSchema = z
  .object({
    id: IdSchema,
    provider: OAuthProviderSchema,
    expiresAt: TimestampSchema,
    accounts: z.array(CandidateAccountSchema).max(MAX_CONNECTION_ACCOUNTS),
  })
  .superRefine((connection, ctx) => {
    const platforms: readonly Platform[] = OAUTH_PROVIDER_PLATFORMS[connection.provider];
    const ids = new Set<string>();
    connection.accounts.forEach((account, index) => {
      if (ids.has(account.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Account ids must not repeat",
          path: ["accounts", index, "id"],
        });
      }
      ids.add(account.id);
      if (!platforms.includes(account.platform)) {
        ctx.addIssue({
          code: "custom",
          message: `A ${connection.provider} sign-in cannot connect a ${account.platform} account`,
          path: ["accounts", index, "platform"],
        });
      }
    });
    connection.accounts.forEach((account, index) => {
      if (
        account.parentId !== null &&
        (account.parentId === account.id || !ids.has(account.parentId))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "The parent must be another account of the connection",
          path: ["accounts", index, "parentId"],
        });
      }
    });
  });
export type ConnectionCandidates = z.infer<typeof ConnectionCandidatesSchema>;

/**
 * Connects the chosen accounts of a pending connection to a workspace, once: afterwards the
 * connection is used and its tokens are gone. New channels are `active` with dry-run on. Unknown
 * ids answer `400 validation_failed`; an account already connected in another workspace answers
 * `409 channel_in_other_workspace`, naming that workspace in `details`.
 */
export const AcceptConnectionSchema = z.object({
  workspaceId: IdSchema,
  accountIds: z
    .array(CandidateAccountIdSchema)
    .min(1)
    .max(MAX_CONNECTION_ACCOUNTS)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Account ids must not repeat" }),
});
export type AcceptConnection = z.infer<typeof AcceptConnectionSchema>;

/** The channels the accept created or reconnected, parents included. */
export const AcceptConnectionResponseSchema = z.object({
  channels: z.array(ChannelSchema),
});
export type AcceptConnectionResponse = z.infer<typeof AcceptConnectionResponseSchema>;

/**
 * An app path to return to after the connect page, such as `/settings/channels`. Only paths on
 * the app itself: it starts with one `/` and has no backslash, so it can never point elsewhere.
 */
export const OAuthRedirectToSchema = z
  .string()
  .max(OAUTH_REDIRECT_TO_MAX_LENGTH)
  .refine((path) => path.startsWith("/") && !path.startsWith("//") && !path.includes("\\"), {
    message: "Use a path on this app, starting with /",
  });

/** Query of `oauth.start`. */
export const OAuthStartQuerySchema = z.object({
  redirectTo: OAuthRedirectToSchema.optional(),
});
export type OAuthStartQuery = z.infer<typeof OAuthStartQuerySchema>;

const CALLBACK_VALUE_MAX_LENGTH = 2_048;
const CallbackValueSchema = z.string().max(CALLBACK_VALUE_MAX_LENGTH).optional();

/**
 * Query the platform sends to `oauth.callback`: `code` and `state` after a sign-in, or `error`
 * (such as `access_denied`) with a reason and description when the user declined. `code` is a
 * credential: it is never logged.
 */
export const OAuthCallbackQuerySchema = z.object({
  code: CallbackValueSchema,
  state: CallbackValueSchema,
  error: CallbackValueSchema,
  error_reason: CallbackValueSchema,
  error_description: CallbackValueSchema,
});
export type OAuthCallbackQuery = z.infer<typeof OAuthCallbackQuerySchema>;

/**
 * The web page `oauth.callback` redirects to. It sits outside any workspace: the page asks which
 * workspace the accounts join, starting from the one the sign-in began in.
 */
export const OAUTH_CONNECT_PAGE_PATH = "/channels/connect";

/**
 * Why a sign-in did not produce a pending connection, as `?error=` on the connect page:
 * - `access_denied`: the user cancelled or declined the permissions.
 * - `invalid_state`: the sign-in expired, was already used or was started by another user.
 * - `provider_error`: the platform refused the code exchange or the account lookup.
 * - `no_accounts`: the sign-in worked but offers no account to publish as, such as no Page.
 * - `not_configured`: the server has no app credentials for the provider, or the provider is
 *   behind a feature flag that is off (`x` while `xPublishing` is off).
 */
export const OAUTH_CONNECT_ERRORS = [
  "access_denied",
  "invalid_state",
  "provider_error",
  "no_accounts",
  "not_configured",
] as const;
export const OAuthConnectErrorSchema = z.enum(OAUTH_CONNECT_ERRORS);
export type OAuthConnectError = (typeof OAUTH_CONNECT_ERRORS)[number];

/**
 * Search params of the connect page: `connection` (the pending connection to show) after a
 * sign-in, or `error` and `provider` when it failed.
 */
export const OAuthConnectSearchSchema = z.object({
  connection: IdSchema.optional(),
  provider: OAuthProviderSchema.optional(),
  error: OAuthConnectErrorSchema.optional(),
});
export type OAuthConnectSearch = z.infer<typeof OAuthConnectSearchSchema>;
