import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { type PasswordTokenPurpose, PasswordTokenPurposeSchema, UserRoleSchema } from "../enums";
import { EmailSchema, NewPasswordSchema } from "./auth";

export const USER_NAME_MAX_LENGTH = 120;

/** How long a set-password link stays valid, per purpose. Links are single use. */
export const PASSWORD_TOKEN_TTL_MS = {
  invite: 7 * 24 * 60 * 60_000,
  reset: 24 * 60 * 60_000,
} as const satisfies Record<PasswordTokenPurpose, number>;

/**
 * The secret in a set-password link: URL-safe characters only, so it travels in a path or fragment
 * unchanged. The server stores only its hash.
 */
export const PASSWORD_TOKEN_RE = /^[0-9A-Za-z_-]{32,128}$/;
export const PasswordTokenSecretSchema = z.string().regex(PASSWORD_TOKEN_RE);

/** A user as listed by the owner. */
export const UserSummarySchema = z.object({
  id: IdSchema,
  email: z.email(),
  name: z.string(),
  role: UserRoleSchema,
  createdAt: TimestampSchema,
  lastLoginAt: TimestampSchema.nullable(),
  disabledAt: TimestampSchema.nullable(),
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

/** Only the owner invites users. The new user picks a password through the returned link. */
export const InviteUserRequestSchema = z.object({
  email: EmailSchema,
  name: z.string().trim().min(1).max(USER_NAME_MAX_LENGTH),
  role: UserRoleSchema,
});
export type InviteUserRequest = z.infer<typeof InviteUserRequestSchema>;

/**
 * A one-time set-password link. It is shown once; the server keeps only the token's hash, and a
 * new link for the same user invalidates the previous one.
 */
export const PasswordLinkSchema = z.object({
  setPasswordUrl: z.url(),
  expiresAt: TimestampSchema,
});
export type PasswordLink = z.infer<typeof PasswordLinkSchema>;

/** Answer to an invitation or a reset link: the user and the link to hand over. Never a password. */
export const InviteUserResponseSchema = PasswordLinkSchema.extend({
  user: UserSummarySchema,
});
export type InviteUserResponse = z.infer<typeof InviteUserResponseSchema>;

/** Answer to `users.resetLink`: the same shape as an invitation, with a `reset` link. */
export const ResetLinkResponseSchema = InviteUserResponseSchema;
export type ResetLinkResponse = InviteUserResponse;

export const InspectPasswordTokenRequestSchema = z.object({
  token: PasswordTokenSecretSchema,
});
export type InspectPasswordTokenRequest = z.infer<typeof InspectPasswordTokenRequestSchema>;

/** What the set-password page shows before the user picks a password. */
export const PasswordTokenInfoSchema = z.object({
  email: z.email(),
  purpose: PasswordTokenPurposeSchema,
  expiresAt: TimestampSchema,
});
export type PasswordTokenInfo = z.infer<typeof PasswordTokenInfoSchema>;

/**
 * Uses a set-password link. The token is consumed, the user's other sessions are revoked, and the
 * user then signs in with the new password.
 */
export const SetPasswordRequestSchema = z.object({
  token: PasswordTokenSecretSchema,
  newPassword: NewPasswordSchema,
});
export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>;
