import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { McpTokenScopeSchema, type TokenKind, TokenKindSchema, TokenScopeSchema } from "../enums";

/** Every secret token starts with a prefix that names its kind, so secret scanners can find it. */
export const TOKEN_PREFIXES = {
  mcp: "lc_mcp_",
  device: "lc_dev_",
} as const satisfies Record<TokenKind, string>;

/** 32 random bytes in base62, left-padded with `0` to a fixed 43 characters. */
export const TOKEN_SECRET_LENGTH = 43;

export const MCP_TOKEN_RE = /^lc_mcp_[0-9A-Za-z]{43}$/;
export const DEVICE_TOKEN_RE = /^lc_dev_[0-9A-Za-z]{43}$/;

export const McpTokenSecretSchema = z.string().regex(MCP_TOKEN_RE);
export const DeviceTokenSecretSchema = z.string().regex(DEVICE_TOKEN_RE);

export const TOKEN_NAME_MAX_LENGTH = 100;

/** A token as listed in Settings. The secret is never included. */
export const AccessTokenSchema = z.object({
  id: IdSchema,
  kind: TokenKindSchema,
  name: z.string(),
  /** First characters of the secret, shown so the user can tell tokens apart. */
  prefix: z.string().min(1).max(32),
  scopes: z.array(TokenScopeSchema),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
});
export type AccessToken = z.infer<typeof AccessTokenSchema>;

/** Creates an MCP token. Only the owner may request `mcp:admin`. */
export const CreateTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(TOKEN_NAME_MAX_LENGTH),
  scopes: z
    .array(McpTokenScopeSchema)
    .min(1)
    .refine((scopes) => new Set(scopes).size === scopes.length, {
      message: "Scopes must not repeat",
    }),
  expiresAt: TimestampSchema.optional(),
});
export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>;

/** `secret` is returned only in this response and is never stored or shown again. */
export const CreateTokenResponseSchema = z.object({
  token: AccessTokenSchema,
  secret: McpTokenSecretSchema,
});
export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;
