import { type Workspace, workspaceTools } from "@loomcast/contracts";
import type { WorkspaceActor, WorkspacesService } from "../../workspaces/service";
import type { McpCaller } from "../caller";
import { defineTool, legacyAlias, McpToolError, type ToolDefinition } from "./registry";

export interface WorkspaceToolsDeps {
  workspaces: WorkspacesService;
  /** Origin of the web app, for links to workspaces. */
  appOrigin: string;
}

/**
 * Workspaces were called projects. Agents and clients built before the rename still call the old
 * names, which are served as deprecated aliases of the workspace tools.
 */
export const LEGACY_WORKSPACE_TOOLS = {
  "project.create": "workspace.create",
  "project.get": "workspace.get",
  "project.list": "workspace.list",
} as const;

/** Most workspaces named one by one in the `workspace.list` summary. */
const LIST_SUMMARY_LIMIT = 20;

const notFound = () => new McpToolError("not_found", "No workspace has that id or slug.");

/** Link to a workspace in the web app. */
export function workspaceUrl(appOrigin: string, workspace: Pick<Workspace, "slug">): string {
  return new URL(`/w/${encodeURIComponent(workspace.slug)}`, appOrigin).toString();
}

/** A token acts for its user; the audit row of the change names the token. */
function actor(caller: McpCaller): WorkspaceActor {
  return { kind: "token", id: caller.token.id, userId: caller.token.user.id, ip: caller.ip };
}

function describe(workspace: Pick<Workspace, "name" | "slug" | "id">): string {
  return `"${workspace.name}" (slug ${workspace.slug}, id ${workspace.id})`;
}

/** `workspace.create`, `workspace.get` and `workspace.list`, backed by the workspaces service. */
export function createWorkspaceTools(deps: WorkspaceToolsDeps): ToolDefinition[] {
  const { workspaces, appOrigin } = deps;

  const create = defineTool(workspaceTools["workspace.create"], {
    async handler(input, { caller }) {
      // The service publishes `workspace.created` once committed, so the web app updates live.
      const workspace = await workspaces.create(input, actor(caller));
      return {
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          description: workspace.description,
          url: workspaceUrl(appOrigin, workspace),
        },
      };
    },
    summary: ({ workspace }) => `Created workspace ${describe(workspace)}: ${workspace.url}`,
  });

  const get = defineTool(workspaceTools["workspace.get"], {
    async resolveWorkspace(input) {
      const workspace = await workspaces.get(input.idOrSlug);
      return workspace?.id ?? null;
    },
    async handler(_input, { workspaceId }) {
      const workspace = workspaceId === null ? null : await workspaces.get(workspaceId);
      if (workspace === null) {
        throw notFound();
      }
      return { workspace, stats: await workspaces.stats(workspace.id) };
    },
    summary: ({ workspace, stats }) =>
      `Workspace ${describe(workspace)} is ${workspace.status}, with ${stats.conversations} conversations, ` +
      `${stats.kbEntries} knowledge-base entries and ${stats.items} content items.`,
  });

  const list = defineTool(workspaceTools["workspace.list"], {
    async handler(input, { caller }) {
      const all = await workspaces.list(input);
      // A bound caller (a job token) only sees its own workspace.
      const visible =
        caller.boundWorkspaceId === null
          ? all
          : all.filter((workspace) => workspace.id === caller.boundWorkspaceId);
      return { workspaces: visible };
    },
    summary: ({ workspaces: found }) => {
      if (found.length === 0) {
        return "No workspaces found.";
      }
      const lines = found
        .slice(0, LIST_SUMMARY_LIMIT)
        .map((workspace) => `- ${describe(workspace)}, ${workspace.status}`);
      if (found.length > LIST_SUMMARY_LIMIT) {
        lines.push(`- and ${found.length - LIST_SUMMARY_LIMIT} more`);
      }
      return [`${found.length} workspace${found.length === 1 ? "" : "s"}:`, ...lines].join("\n");
    },
  });

  const byName = { "workspace.create": create, "workspace.get": get, "workspace.list": list };
  return [
    create,
    get,
    list,
    ...Object.entries(LEGACY_WORKSPACE_TOOLS).map(([legacy, current]) =>
      legacyAlias(byName[current], legacy),
    ),
  ];
}
