import {
  type ResearchAccount,
  type ResearchSyncStatus,
  type ResearchVideo,
  researchTools,
} from "@loomcast/contracts";
import type { WorkspacesService } from "../../workspaces/service";
import type { ResearchService } from "../../research/service";
import { ownerActor } from "./owner";
import { defineTool, McpToolError, type ToolContext, type ToolDefinition } from "./registry";

export interface ResearchToolsDeps {
  research: ResearchService;
  workspaces: Pick<WorkspacesService, "get">;
}

/** Most rows named one by one in a text summary; the structured result has them all. */
const SUMMARY_LIMIT = 50;

const workspaceNotFound = () => new McpToolError("not_found", "No workspace has that id or slug.");

/** The workspace of an `input` tool's call. The registry has already checked it for bound callers. */
function boundWorkspace(ctx: ToolContext): string {
  if (ctx.workspaceId === null) {
    throw workspaceNotFound();
  }
  return ctx.workspaceId;
}

function number(value: number | null): string {
  return value === null ? "?" : value.toLocaleString("en-US");
}

function describeAccount(account: ResearchAccount): string {
  return (
    `${account.platform} @${account.handle} (id ${account.id}, ${account.source}, ` +
    `${number(account.followers)} followers, median ${number(account.medianViews)} views, ` +
    `${account.videoCount} videos)`
  );
}

function describeSync(sync: ResearchSyncStatus): string {
  if (sync.status === "synced") return `Synced ${sync.videos} videos.`;
  return `Sync ${sync.status}: ${sync.message ?? "no reason given"}`;
}

/** One line per video, without captions: those stay in the structured result. */
function describeVideo(video: ResearchVideo): string {
  const outlier = video.outlierScore === null ? "?" : `${video.outlierScore}x`;
  const topic = video.topic === null ? "untagged" : `topic "${video.topic}"`;
  return (
    `- ${video.id} ${video.platform} @${video.handle}: ${number(video.views)} views, ` +
    `outlier ${outlier}, ${topic}${video.url === null ? "" : `, ${video.url}`}`
  );
}

function limited(lines: string[], total: number): string[] {
  return total > SUMMARY_LIMIT ? [...lines, `- and ${total - SUMMARY_LIMIT} more`] : lines;
}

/** `research.*` tools, backed by the research service. Writes are the owner's alone. */
export function createResearchTools(deps: ResearchToolsDeps): ToolDefinition[] {
  const { research, workspaces } = deps;

  async function workspaceOf(ref: string): Promise<string | null> {
    return (await workspaces.get(ref))?.id ?? null;
  }

  const trackAccount = defineTool(researchTools["research.track_account"], {
    resolveWorkspace: (input) => workspaceOf(input.workspace),
    async handler(input, ctx) {
      ownerActor(ctx.caller, "change research data");
      return research.trackAccount(boundWorkspace(ctx), {
        platform: input.platform,
        handle: input.handle,
        notes: input.notes,
        ...(input.sync === undefined ? {} : { sync: input.sync }),
      });
    },
    summary: ({ account, sync }) => `Tracking ${describeAccount(account)}. ${describeSync(sync)}`,
    auditData: ({ account, sync }) => ({ accountId: account.id, sync: sync.status }),
  });

  const syncAccount = defineTool(researchTools["research.sync_account"], {
    resolveWorkspace: async (input) =>
      (await research.getAccount(input.accountId))?.workspaceId ?? null,
    async handler(input, ctx) {
      ownerActor(ctx.caller, "change research data");
      const result = await research.syncAccount(input.accountId);
      if (result === null) {
        throw new McpToolError("not_found", "No research account has that id.");
      }
      return result;
    },
    summary: ({ account, sync }) => `${describeSync(sync)} ${describeAccount(account)}.`,
    auditData: ({ account, sync }) => ({ accountId: account.id, sync: sync.status }),
  });

  const addVideos = defineTool(researchTools["research.add_videos"], {
    resolveWorkspace: (input) => workspaceOf(input.workspace),
    async handler(input, ctx) {
      ownerActor(ctx.caller, "change research data");
      return research.addVideos(boundWorkspace(ctx), input.videos);
    },
    summary: ({ created, updated, snapshots, videos }) => {
      const lines = videos
        .slice(0, SUMMARY_LIMIT)
        .map(
          (video) =>
            `- ${video.id} @${video.handle} ${video.externalId}: ${video.created ? "new" : "updated"}, ` +
            `outlier ${video.outlierScore === null ? "?" : `${video.outlierScore}x`}`,
        );
      return [
        `Stored ${created} new and ${updated} updated videos (${snapshots} metric snapshots).`,
        ...limited(lines, videos.length),
      ].join("\n");
    },
    auditData: ({ created, updated }) => ({ created, updated }),
  });

  const tagVideo = defineTool(researchTools["research.tag_video"], {
    async handler(input, ctx) {
      ownerActor(ctx.caller, "change research data");
      const { updated, missing } = await research.tagVideos(input);
      return { updated, missing };
    },
    summary: ({ updated, missing }) =>
      `Labelled ${updated} video${updated === 1 ? "" : "s"}.` +
      (missing.length === 0 ? "" : ` No video has these ids: ${missing.join(", ")}.`),
    auditData: ({ updated }) => ({ updated }),
  });

  const listVideos = defineTool(researchTools["research.list_videos"], {
    resolveWorkspace: (input) => workspaceOf(input.workspace),
    async handler(input, ctx) {
      const { workspace: _workspace, ...filter } = input;
      return research.listVideos(boundWorkspace(ctx), filter);
    },
    summary: ({ videos, nextCursor }) => {
      if (videos.length === 0) return "No research videos match.";
      const lines = videos.slice(0, SUMMARY_LIMIT).map(describeVideo);
      return [
        `${videos.length} video${videos.length === 1 ? "" : "s"}:`,
        ...limited(lines, videos.length),
        ...(nextCursor === null ? [] : [`More with cursor ${nextCursor}.`]),
      ].join("\n");
    },
  });

  const topTopics = defineTool(researchTools["research.top_topics"], {
    resolveWorkspace: (input) => workspaceOf(input.workspace),
    async handler(input, ctx) {
      return research.topTopics(boundWorkspace(ctx), input);
    },
    summary: ({ topics, untagged, windowDays }) => {
      const header =
        topics.length === 0
          ? `No tagged topics in the last ${windowDays} days.`
          : `${topics.length} topics in the last ${windowDays} days, best first:`;
      const lines = topics.map(
        (topic) =>
          `- "${topic.topic}" score ${topic.topicScore}${topic.proven ? " (proven)" : ""}: ` +
          `${topic.videos} videos, ${topic.creators} creators, ${topic.hitCreators} hit creators, ` +
          `median ${number(topic.medianViews)} views, best outlier ${topic.bestOutlier ?? "?"}x, ` +
          `${topic.saturation} in the last 30 days` +
          (topic.own === null
            ? ""
            : `; ours: ${topic.own.posts} posts, median ${number(topic.own.medianViews)} views`),
      );
      return [
        header,
        ...lines,
        ...(untagged === 0 ? [] : [`${untagged} videos are untagged (research.tag_video).`]),
      ].join("\n");
    },
  });

  const listAccounts = defineTool(researchTools["research.list_accounts"], {
    resolveWorkspace: (input) => workspaceOf(input.workspace),
    async handler(input, ctx) {
      const accounts = await research.listAccounts(boundWorkspace(ctx), {
        platform: input.platform,
        source: input.source,
      });
      return { accounts };
    },
    summary: ({ accounts }) => {
      if (accounts.length === 0) return "No research accounts yet.";
      const lines = accounts
        .slice(0, SUMMARY_LIMIT)
        .map((account) => `- ${describeAccount(account)}`);
      return [`${accounts.length} accounts:`, ...limited(lines, accounts.length)].join("\n");
    },
  });

  return [trackAccount, syncAccount, addVideos, tagVideo, listVideos, topTopics, listAccounts];
}
