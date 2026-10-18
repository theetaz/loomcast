import {
  type ContentItem,
  type ContentVersion,
  formatMediaIssues,
  mediaTypeOfMime,
  type PipelineState,
  PLATFORM_LABELS,
  type PostFormat,
  type PostMediaEntry,
  PRODUCTION_STATES,
  platformRefusal,
  postFormatCatalog,
  postTools,
  type ScheduledPost,
} from "@loomcast/contracts";
import { type AssetRow, channels, type Database, scheduledPosts } from "@loomcast/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { type Executor, type Transaction, transaction } from "../../../lib/db";
import { validationFailed } from "../../../lib/errors";
import type { CalendarService } from "../../calendar/service";
import { type ContentService, staleVersion } from "../../content";
import { lockItem } from "../../content/queries";
import { requireActiveProject } from "../../kb/service";
import type { ReviewsService } from "../../reviews/service";
import { ownerActor } from "./owner";
import { defineTool, McpToolError, type ToolContext, type ToolDefinition } from "./registry";

export interface PostToolsDeps {
  db: Database;
  content: Pick<ContentService, "create" | "createVersion" | "getItem" | "getVersion" | "submit">;
  reviews: Pick<ReviewsService, "create">;
  calendar: Pick<CalendarService, "create">;
  assets: { getRow(id: string, executor?: Executor): Promise<AssetRow | null> };
}

/** The next call for a post in this state, for the result and the text summary. */
function nextStep(item: ContentItem, version: ContentVersion): string {
  if (formatMediaIssues(version).length > 0) {
    return (
      `Upload the missing files with content.upload_asset (kind media, itemId ${item.id}) and ` +
      "content.finalize_asset, then call post.compose with them."
    );
  }
  if (item.state === "scheduled" || item.state === "published") {
    return "The post is scheduled; calendar.list_posts shows it.";
  }
  if (item.state === "archived") {
    return "The post is archived.";
  }
  return `Call post.schedule with itemId ${item.id} and channels from channel.list.`;
}

function composed(item: ContentItem, version: ContentVersion) {
  return { item, version, issues: formatMediaIssues(version), next: nextStep(item, version) };
}

/**
 * The reasons the item cannot go out on each channel, in the order given: an unknown or disabled
 * channel, a platform that does not publish the format, or an open post of the item already
 * there. Checked before anything changes, so a refusal names every channel at once.
 */
async function refusedChannels(
  tx: Transaction,
  itemId: string,
  version: { format: PostFormat; media: readonly Pick<PostMediaEntry, "type">[] },
  channelIds: readonly string[],
): Promise<{ path: string; message: string; format: boolean }[]> {
  const rows = await tx
    .select({
      id: channels.id,
      platform: channels.platform,
      status: channels.status,
      displayName: channels.displayName,
    })
    .from(channels)
    .where(inArray(channels.id, [...channelIds]));
  const open = await tx
    .select({ channelId: scheduledPosts.channelId })
    .from(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.itemId, itemId),
        inArray(scheduledPosts.channelId, [...channelIds]),
        ne(scheduledPosts.status, "cancelled"),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const taken = new Set(open.map((row) => row.channelId));
  const refused: { path: string; message: string; format: boolean }[] = [];
  for (const [index, id] of channelIds.entries()) {
    const path = `channelIds.${index}`;
    const channel = byId.get(id);
    if (channel === undefined) {
      refused.push({ path, message: "No channel has that id", format: false });
      continue;
    }
    const name = `${channel.displayName} (${PLATFORM_LABELS[channel.platform]})`;
    const refusal = platformRefusal(channel.platform, version);
    if (refusal !== null) {
      refused.push({ path, message: `${name}: ${refusal.replace(/\.$/, "")}`, format: true });
    } else if (channel.status === "disabled") {
      refused.push({ path, message: `${name}: the channel is disabled`, format: false });
    } else if (taken.has(id)) {
      refused.push({ path, message: `${name}: the item already has a post here`, format: false });
    }
  }
  return refused;
}

/**
 * `post.formats` and the owner's `post.create`, `post.compose` and `post.schedule`: composed posts
 * through the same content, review and calendar services as the web app.
 */
export function createPostTools(deps: PostToolsDeps): ToolDefinition[] {
  const { db, content, reviews, calendar, assets } = deps;

  async function itemProject(itemId: string): Promise<string | null> {
    return (await content.getItem(itemId))?.projectId ?? null;
  }

  function projectOf(ctx: ToolContext, what: string): string {
    if (ctx.projectId === null) {
      throw new McpToolError("not_found", `No ${what} has that id.`);
    }
    return ctx.projectId;
  }

  /** Media entries with their type read from each asset's MIME type. */
  async function mediaEntries(
    itemId: string,
    media: readonly { assetId: string; altText?: string | undefined }[],
  ): Promise<PostMediaEntry[]> {
    const entries: PostMediaEntry[] = [];
    for (const [index, entry] of media.entries()) {
      const row = await assets.getRow(entry.assetId);
      const type = row === null ? null : mediaTypeOfMime(row.mime);
      if (row === null || row.itemId !== itemId || type === null) {
        // The content service checks kind and readiness; this is only about reading the type.
        throw validationFailed([
          { path: `media.${index}.assetId`, message: "No media asset with that id on this item" },
        ]);
      }
      entries.push({
        assetId: entry.assetId,
        type,
        ...(entry.altText === undefined ? {} : { altText: entry.altText }),
      });
    }
    return entries;
  }

  const formats = defineTool(postTools["post.formats"], {
    handler: async () => postFormatCatalog(),
    summary: ({ formats: all, platforms }) =>
      `${all.length} post formats on ${platforms.length} platforms.`,
  });

  const create = defineTool(postTools["post.create"], {
    resolveProject: async (input) => input.projectId,
    async handler(input, ctx) {
      const actor = ownerActor(ctx.caller, "create posts");
      const projectId = projectOf(ctx, "project");
      const result = await transaction(db, async (tx) => {
        const created = await content.create(
          projectId,
          {
            title: input.title,
            format: input.format,
            ...(input.pitch === undefined ? {} : { pitch: input.pitch }),
            ...(input.targetAt === undefined ? {} : { targetAt: input.targetAt }),
          },
          actor,
          { tx, createdVia: "mcp" },
        );
        if (input.caption === undefined) {
          return { item: created.item, version: created.currentVersion };
        }
        // Version 1 is the bare idea; the caption is the post's first version.
        return content.createVersion(tx, created.item.id, { caption: input.caption }, actor, {
          createdVia: "mcp",
        });
      });
      return composed(result.item, result.version);
    },
    summary: ({ item, version, next }) =>
      `Created ${version.format} post ${item.id} (version ${version.id}); it is in ` +
      `${item.state}. ${next}`,
    auditData: ({ item, version }) => ({ itemId: item.id, versionId: version.id }),
  });

  const compose = defineTool(postTools["post.compose"], {
    resolveProject: (input) => itemProject(input.itemId),
    async handler(input, ctx) {
      const actor = ownerActor(ctx.caller, "compose posts");
      const projectId = projectOf(ctx, "content item");
      const item = await content.getItem(input.itemId);
      if (item === null || item.projectId !== projectId) {
        throw new McpToolError("not_found", "No content item has that id.");
      }
      const media =
        input.media === undefined ? undefined : await mediaEntries(item.id, input.media);
      const result = await transaction(db, async (tx) => {
        await requireActiveProject(tx, item.projectId);
        return content.createVersion(
          tx,
          item.id,
          {
            ...(input.format === undefined ? {} : { format: input.format }),
            ...(media === undefined ? {} : { media }),
            ...(input.caption === undefined ? {} : { caption: input.caption }),
            ...(input.notes === undefined ? {} : { notes: input.notes }),
          },
          actor,
          {
            createdVia: "mcp",
            ...(input.baseVersionId === undefined ? {} : { baseVersionId: input.baseVersionId }),
          },
        );
      });
      return composed(result.item, result.version);
    },
    summary: ({ item, version, issues, next }) =>
      `Saved version ${version.versionNo} (id ${version.id}) of post ${item.id}; it is in ` +
      `${item.state}.${issues.length === 0 ? "" : ` Missing: ${issues.join(" ")}`} ${next}`,
    auditData: ({ item, version }) => ({
      itemId: item.id,
      versionId: version.id,
      state: item.state,
    }),
  });

  const schedule = defineTool(postTools["post.schedule"], {
    resolveProject: (input) => itemProject(input.itemId),
    async handler(input, ctx) {
      const actor = ownerActor(ctx.caller, "schedule posts");
      const projectId = projectOf(ctx, "content item");
      return transaction(db, async (tx) => {
        // The item is locked first, as every writer of an item and its posts does.
        const item = await lockItem(tx, input.itemId);
        if (item === null || item.projectId !== projectId) {
          throw new McpToolError("not_found", "No content item has that id.");
        }
        const versionId = item.currentVersionId;
        if (input.versionId !== undefined && input.versionId !== versionId) {
          throw staleVersion(versionId);
        }
        const version = await content.getVersion(item.id, versionId, tx);
        if (version === null) {
          throw new Error("content item without its current version");
        }
        const refused = await refusedChannels(tx, item.id, version, input.channelIds);
        if (refused.length > 0) {
          if (refused.every((issue) => issue.format)) {
            throw new McpToolError(
              "format_not_supported",
              `No post was scheduled. ${refused.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}.`,
            );
          }
          throw validationFailed(
            refused.map(({ path, message }) => ({ path, message })),
            "No post was scheduled: some channels were refused.",
          );
        }

        let state: PipelineState = item.state;
        if ((PRODUCTION_STATES as readonly PipelineState[]).includes(state)) {
          const issues = formatMediaIssues(version);
          if (issues.length > 0) {
            throw new McpToolError(
              "missing_artifact",
              `The post is not ready: ${issues.join(" ")}`,
            );
          }
          state = (await content.submit(item.id, { versionId }, actor, { tx })).state;
        }
        let reviewId: string | null = null;
        if (state === "review") {
          const decided = await reviews.create(item.id, { versionId, decision: "approve" }, actor, {
            tx,
          });
          if (decided === null) {
            throw new McpToolError("not_found", "No content item has that id.");
          }
          reviewId = decided.review.id;
        }

        const posts: ScheduledPost[] = [];
        for (const channelId of input.channelIds) {
          posts.push(
            await calendar.create(
              {
                itemId: item.id,
                channelId,
                scheduledAt: input.scheduledAt,
                ...(input.options === undefined ? {} : { options: input.options }),
              },
              actor,
              { tx },
            ),
          );
        }
        const after = await content.getItem(item.id, tx);
        return {
          itemId: item.id,
          versionId,
          state: after?.state ?? state,
          reviewId,
          posts,
        };
      });
    },
    summary: ({ itemId, state, posts }) =>
      `Scheduled item ${itemId} on ${posts.length} channel${posts.length === 1 ? "" : "s"} ` +
      `(posts ${posts.map((post) => post.id).join(", ")}) for ${posts[0]?.scheduledAt}; the ` +
      `item is now ${state}.`,
    auditData: ({ itemId, reviewId, posts }) => ({
      itemId,
      reviewId,
      postIds: posts.map((post) => post.id),
    }),
  });

  return [formats, create, compose, schedule];
}
