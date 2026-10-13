import {
  IdSchema,
  KB_SNIPPET_MATCH_END,
  KB_SNIPPET_MATCH_START,
  type KbCreatedVia,
  type KbEntryDetail,
  kbTools,
} from "@loomcast/contracts";
import { jobs } from "@loomcast/db";
import { eq } from "drizzle-orm";
import type { Executor } from "../../../lib/db";
import { HttpError } from "../../../lib/errors";
import type { KbActor, KbService } from "../../kb/service";
import type { McpCaller } from "../caller";
import { defineTool, McpToolError, type ToolContext, type ToolDefinition } from "./registry";

export interface KbToolsDeps {
  kb: KbService;
  /** Where the job behind a job token is looked up, for its conversation. */
  db: Executor;
  /** Origin of the web app, for links to entries. */
  appOrigin: string;
}

/** Most search hits named one by one in the `kb.search` summary. */
const SEARCH_SUMMARY_LIMIT = 10;

/** A snippet for the text summary, without the match marks. */
function plainSnippet(snippet: string): string {
  return snippet
    .replaceAll(KB_SNIPPET_MATCH_START, "")
    .replaceAll(KB_SNIPPET_MATCH_END, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The project folder of a producer session or MCP client on the studio Mac:
 * `<workspace root>/Loomcast/projects/<project id>`, possibly with a subfolder after it.
 * Windows separators are accepted too.
 */
const PROJECT_CWD_RE =
  /[/\\]Loomcast[/\\]projects[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[/\\]|$)/gi;

/** Link to a knowledge-base entry in the web app. */
export function kbEntryUrl(appOrigin: string, projectId: string, entryId: string): string {
  return new URL(
    `/projects/${encodeURIComponent(projectId)}/kb/${encodeURIComponent(entryId)}`,
    appOrigin,
  ).toString();
}

/**
 * The project a working directory belongs to, from its `Loomcast/projects/<uuid>` segment, or
 * null when it has none. The last such segment wins.
 */
export function projectIdFromCwd(cwd: string): string | null {
  const matches = [...cwd.matchAll(PROJECT_CWD_RE)];
  const id = matches.at(-1)?.[1]?.toLowerCase();
  return id !== undefined && IdSchema.safeParse(id).success ? id : null;
}

/**
 * Who writes: the token acting for its user. Entries written with a job token come from a
 * producer session (`producer`); other tokens are MCP clients (`mcp`).
 */
function actor(caller: McpCaller, via?: KbCreatedVia): KbActor {
  return {
    kind: "token",
    id: caller.token.id,
    userId: caller.token.user.id,
    via: via ?? (caller.token.kind === "job" ? "producer" : "mcp"),
    ip: caller.ip,
  };
}

/** The project of an `input` tool's call. The registry has already checked it for bound callers. */
function boundProject(ctx: ToolContext): string {
  if (ctx.projectId === null) {
    throw new McpToolError("not_found", "No project has that id.");
  }
  return ctx.projectId;
}

function describeEntry(entry: Pick<KbEntryDetail, "title" | "id">): string {
  return `"${entry.title}" (id ${entry.id})`;
}

/** `kb.*` tools, backed by the knowledge-base service. */
export function createKbTools(deps: KbToolsDeps): ToolDefinition[] {
  const { kb, db, appOrigin } = deps;

  /**
   * The conversation of the job behind a job token, so entries a producer session writes link back
   * to the chat they came from. Null for user tokens and for jobs without a conversation.
   */
  async function jobConversation(caller: McpCaller): Promise<string | null> {
    if (caller.jobId === null) {
      return null;
    }
    const [row] = await db
      .select({ conversationId: jobs.conversationId })
      .from(jobs)
      .where(eq(jobs.id, caller.jobId))
      .limit(1);
    return row?.conversationId ?? null;
  }

  const saveBrainstorm = defineTool(kbTools["kb.save_brainstorm"], {
    resolveProject: async (input) => input.projectId,
    async handler(input, ctx) {
      const projectId = boundProject(ctx);
      const entry = await kb.create(
        projectId,
        {
          kind: "brainstorm",
          title: input.title,
          bodyMd: input.bodyMd,
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
          conversationId: await jobConversation(ctx.caller),
        },
        actor(ctx.caller),
      );
      return { entryId: entry.id, url: kbEntryUrl(appOrigin, projectId, entry.id) };
    },
    summary: ({ entryId, url }) => `Saved brainstorm ${entryId}: ${url}`,
  });

  const addReference = defineTool(kbTools["kb.add_reference"], {
    resolveProject: async (input) => input.projectId,
    async handler(input, ctx) {
      const projectId = boundProject(ctx);
      try {
        // Saved as given: a reference is analysed only when someone asks for it (`kb.analyze`),
        // never on creation, and its link is never fetched.
        const entry = await kb.create(
          projectId,
          {
            kind: "reference",
            url: input.url,
            ...(input.platform === undefined ? {} : { platform: input.platform }),
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.author === undefined ? {} : { author: input.author }),
            ...(input.likedReason === undefined ? {} : { likedReason: input.likedReason }),
            ...(input.transcript === undefined ? {} : { transcript: input.transcript }),
            ...(input.analysis === undefined ? {} : { analysis: input.analysis }),
            ...(input.tags === undefined ? {} : { tags: input.tags }),
            conversationId: await jobConversation(ctx.caller),
          },
          actor(ctx.caller),
        );
        return { entryId: entry.id };
      } catch (error) {
        throw duplicateReference(error) ?? error;
      }
    },
    summary: ({ entryId }) => `Saved reference ${entryId}.`,
  });

  const addDecision = defineTool(kbTools["kb.add_decision"], {
    resolveProject: async (input) => input.projectId,
    async handler(input, ctx) {
      const projectId = boundProject(ctx);
      const entry = await kb.create(
        projectId,
        {
          kind: "decision",
          title: input.title,
          decision: input.decision,
          ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
          ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          conversationId: await jobConversation(ctx.caller),
        },
        actor(ctx.caller),
      );
      return { entryId: entry.id };
    },
    summary: ({ entryId }) => `Recorded decision ${entryId}.`,
  });

  const search = defineTool(kbTools["kb.search"], {
    // Left out, the search spans every project, or only the bound project for a job token.
    resolveProject: async (input) => input.projectId,
    async handler(input, { projectId }) {
      const hits = await kb.search({
        q: input.query,
        ...(projectId === null ? {} : { projectId }),
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return { hits };
    },
    summary: ({ hits }) => {
      if (hits.length === 0) {
        return "No knowledge-base entries match.";
      }
      const lines = hits
        .slice(0, SEARCH_SUMMARY_LIMIT)
        .map(
          (hit) =>
            `- ${hit.kind} "${hit.title}" (id ${hit.entryId}, project ${hit.projectId}): ` +
            plainSnippet(hit.snippet),
        );
      if (hits.length > SEARCH_SUMMARY_LIMIT) {
        lines.push(`- and ${hits.length - SEARCH_SUMMARY_LIMIT} more`);
      }
      return [`${hits.length} match${hits.length === 1 ? "" : "es"}:`, ...lines].join("\n");
    },
  });

  const get = defineTool(kbTools["kb.get"], {
    async resolveProject(input) {
      const entry = await kb.get(input.entryId);
      return entry?.projectId ?? null;
    },
    async handler(input, { projectId }) {
      const entry = projectId === null ? null : await kb.get(input.entryId);
      // Checked again: the entry may have been deleted or moved since the binding was resolved.
      if (entry === null || entry.projectId !== projectId) {
        throw new McpToolError("not_found", "No knowledge-base entry has that id.");
      }
      return { entry };
    },
    summary: ({ entry }) =>
      `${entry.kind} ${describeEntry(entry)} in project ${entry.projectId}, updated ${entry.updatedAt}.`,
  });

  const saveSessionSummary = defineTool(kbTools["kb.save_session_summary"], {
    async resolveProject(input) {
      if (input.projectId !== undefined) {
        return input.projectId;
      }
      const fromCwd = input.cwd === undefined ? null : projectIdFromCwd(input.cwd);
      if (fromCwd === null) {
        throw new McpToolError(
          "project_unresolved",
          "Name the project with projectId, or call from a Loomcast/projects/<project id> folder.",
        );
      }
      return fromCwd;
    },
    async handler(input, ctx) {
      const projectId = boundProject(ctx);
      // Written by the session-end hook, so the entry is marked `hook`.
      const { entry } = await kb.saveSessionSummary(
        projectId,
        {
          sessionId: input.sessionId,
          summaryMd: input.summaryMd,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        },
        actor(ctx.caller, "hook"),
      );
      return { entryId: entry.id };
    },
    summary: ({ entryId }) => `Saved session summary ${entryId}.`,
  });

  return [saveBrainstorm, addReference, addDecision, search, get, saveSessionSummary];
}

/** A duplicate reference as a conflict that names the entry already saved. */
function duplicateReference(error: unknown): McpToolError | null {
  if (!(error instanceof HttpError) || error.status !== 409) {
    return null;
  }
  const details = error.details as { reason?: unknown; entryId?: unknown } | undefined;
  if (details?.reason !== "duplicate") {
    return null;
  }
  const entry = typeof details.entryId === "string" ? ` as entry ${details.entryId}` : "";
  return new McpToolError("conflict", `This reference is already saved in the project${entry}.`);
}
