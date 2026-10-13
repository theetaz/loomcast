import { adminTools } from "@loomcast/contracts";
import type { UsersService } from "../../auth/users";
import { defineTool, McpToolError, type ToolDefinition } from "./registry";

export interface AdminToolsDeps {
  users: Pick<UsersService, "invite">;
}

/**
 * `admin.create_user`: invites an admin, like the owner's invitation in the web app. Only the
 * owner's tokens carry `mcp:admin`, and the registry checks the scope; the owner is checked here as
 * well, so a token that kept the scope by mistake still cannot invite anyone.
 *
 * The one-time link is returned in `structuredContent` only. The text summary leaves it out, so
 * clients that show or log the text do not spread it.
 */
export function createAdminTools(deps: AdminToolsDeps): ToolDefinition[] {
  const { users } = deps;

  const createUser = defineTool(adminTools["admin.create_user"], {
    async handler(input, { caller }) {
      if (caller.token.user.role !== "owner") {
        throw new McpToolError("forbidden", "Only the owner can create users.");
      }
      const { user, link } = await users.invite(input, {
        kind: "token",
        id: caller.token.id,
        userId: caller.token.user.id,
        ip: caller.ip,
      });
      return { userId: user.id, setPasswordUrl: link.setPasswordUrl, expiresAt: link.expiresAt };
    },
    summary: ({ userId, expiresAt }) =>
      `Invited user ${userId}. The set-password link is in the structured result and expires at ${expiresAt}; hand it to the user privately.`,
  });

  return [createUser];
}
