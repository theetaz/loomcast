import {
  type ContentItem,
  type ContentVersion,
  formatMediaIssues,
  mediaTypeOfMime,
  type PostMediaEntry,
  postFormatCatalog,
  postTools,
} from "@loomcast/contracts";
import type { AssetRow, Database } from "@loomcast/db";
import { type Executor, transaction } from "../../../lib/db";
import { validationFailed } from "../../../lib/errors";
import { refusedChannels, scheduleComposed, throwRefusals } from "../../calendar/compose";
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
  calendar: Pick<CalendarService, "create" | "plan">;
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
        throwRefusals(await refusedChannels(tx, item.id, version, input.channelIds));
        const scheduled = await scheduleComposed(
          tx,
          { content, reviews, calendar },
          {
            item,
            version,
            targets: input.channelIds.map((channelId) => ({
              channelId,
              ...(input.options === undefined ? {} : { options: input.options }),
            })),
            scheduledAt: input.scheduledAt,
            approve: {},
          },
          actor,
        );
        return { itemId: item.id, versionId, ...scheduled };
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
