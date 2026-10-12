import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { UserRoleSchema } from "../enums";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Emails are compared and stored in lowercase. */
export const EmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** A new password. Login accepts any non-empty password, so the minimum applies only here. */
export const NewPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/** The signed-in user, returned by login and `GET /api/auth/me`. */
export const MeSchema = z.object({
  id: IdSchema,
  email: z.email(),
  name: z.string(),
  role: UserRoleSchema,
  createdAt: TimestampSchema,
  lastLoginAt: TimestampSchema.nullable(),
});
export type Me = z.infer<typeof MeSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: NewPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
