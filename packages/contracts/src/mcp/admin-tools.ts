import { z } from "zod";
import { InviteUserRequestSchema } from "../api/users";
import { IdSchema, TimestampSchema } from "../common";
import type { McpToolContract } from "./contract";

export const AdminCreateUserInputSchema = InviteUserRequestSchema;
export type AdminCreateUserInput = z.infer<typeof AdminCreateUserInputSchema>;

/** The new user sets a password through the one-time link. A password is never returned. */
export const AdminCreateUserOutputSchema = z.object({
  userId: IdSchema,
  setPasswordUrl: z.url(),
  expiresAt: TimestampSchema,
});
export type AdminCreateUserOutput = z.infer<typeof AdminCreateUserOutputSchema>;

/** Administration tools. They need `mcp:admin`, which only the owner's tokens carry. */
export const adminTools = {
  "admin.create_user": {
    name: "admin.create_user",
    scope: "mcp:admin",
    jobTokens: "deny",
    workspaceBinding: "none",
    description:
      "Invite a user. Returns a one-time link where the user sets a password, and when it expires.",
    input: AdminCreateUserInputSchema,
    output: AdminCreateUserOutputSchema,
  },
} as const satisfies Record<string, McpToolContract>;

export type AdminToolName = keyof typeof adminTools;
