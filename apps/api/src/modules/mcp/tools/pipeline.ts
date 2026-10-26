import { type ContentCreatedVia, pipelineTools } from "@loomcast/contracts";
import type { Database } from "@loomcast/db";
import { transaction } from "../../../lib/db";
import type { ContentService, PipelineActor } from "../../content";
import type { FormatsService } from "../../formats";
import { requireActiveWorkspace } from "../../kb/service";
import type { SeriesService } from "../../series/service";
import type { McpCaller } from "../caller";
import { defineTool, McpToolError, type ToolContext, type ToolDefinition } from "./registry";

export interface PipelineToolsDeps {
  db: Database;
  content: ContentService;
  formats: FormatsService;
  series: SeriesService;
}

/** The token acting for its user, as the content service records it. */
export function tokenActor(caller: McpCaller): PipelineActor {
  return { kind: "token", id: caller.token.id, userId: caller.token.user.id, ip: caller.ip };
}

/** Items a producer session's job token creates are marked `producer`; other tokens `mcp`. */
function createdVia(caller: McpCaller): ContentCreatedVia {
  return caller.token.kind === "job" ? "producer" : "mcp";
}

/** The workspace of an `input` tool's call; null means the record it names does not exist. */
function workspaceOf(ctx: ToolContext, what: string): string {
  if (ctx.workspaceId === null) {
    throw new McpToolError("not_found", `No ${what} has that id.`);
  }
  return ctx.workspaceId;
}

/** `format.get_rules` and the `content.*` tools that read and write items and their versions. */
export function createPipelineTools(deps: PipelineToolsDeps): ToolDefinition[] {
  const { db, content, formats, series } = deps;

  /** The workspace of an item, or null when there is no such item. */
  async function itemWorkspace(itemId: string): Promise<string | null> {
    return (await content.getItem(itemId))?.workspaceId ?? null;
  }

  /** The item, checked against the workspace the call was bound to. */
  async function boundItem(itemId: string, ctx: ToolContext) {
    const workspaceId = workspaceOf(ctx, "content item");
    const item = await content.getItem(itemId);
    // Checked again: the item may have gone since the binding was resolved.
    if (item === null || item.workspaceId !== workspaceId) {
      throw new McpToolError("not_found", "No content item has that id.");
    }
    return item;
  }

  const getRules = defineTool(pipelineTools["format.get_rules"], {
    async resolveWorkspace(input) {
      return (await series.get(input.seriesId))?.workspaceId ?? null;
    },
    async handler(input, ctx) {
      workspaceOf(ctx, "series");
      const rules = await formats.rulesForSeries(input.seriesId);
      if (rules === null) {
        throw new McpToolError("not_found", "No series has that id.");
      }
      return rules;
    },
    summary: (output) =>
      `Format "${output.name}" (id ${output.formatId}) version ${output.version} ` +
      `(formatVersionId ${output.formatVersionId}).`,
  });

  const createIdea = defineTool(pipelineTools["content.create_idea"], {
    resolveWorkspace: async (input) => input.workspaceId,
    async handler(input, ctx) {
      const workspaceId = workspaceOf(ctx, "workspace");
      const created = await content.create(
        workspaceId,
        {
          title: input.title,
          pitch: input.pitch,
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(input.seriesId === undefined ? {} : { seriesId: input.seriesId }),
        },
        tokenActor(ctx.caller),
        { createdVia: createdVia(ctx.caller) },
      );
      return { itemId: created.item.id };
    },
    summary: ({ itemId }) => `Created idea ${itemId}.`,
  });

  const get = defineTool(pipelineTools["content.get"], {
    resolveWorkspace: (input) => itemWorkspace(input.itemId),
    async handler(input, ctx) {
      const item = await boundItem(input.itemId, ctx);
      const version = await content.getVersion(item.id, input.versionId ?? item.currentVersionId);
      if (version === null) {
        throw new McpToolError("not_found", "The item has no version with that id.");
      }
      const format = await content.formatSnapshot(item.id);
      return { item, version, format };
    },
    summary: ({ item, version }) =>
      `"${item.title}" (id ${item.id}) is in ${item.state}; version ${version.versionNo} ` +
      `(id ${version.id})${version.id === item.currentVersionId ? " is current" : ""}.`,
  });

  const submitForReview = defineTool(pipelineTools["content.submit_for_review"], {
    resolveWorkspace: (input) => itemWorkspace(input.itemId),
    async handler(input, ctx) {
      const item = await boundItem(input.itemId, ctx);
      const result = await transaction(db, async (tx) => {
        await requireActiveWorkspace(tx, item.workspaceId);
        const actor = tokenActor(ctx.caller);
        // The state is the stage the new artifacts reach; tokens are never allowed to approve.
        const written = await content.createVersion(
          tx,
          item.id,
          {
            ...(input.script === undefined ? {} : { script: input.script }),
            ...(input.storyboard === undefined ? {} : { storyboard: input.storyboard }),
            ...(input.voiceAssetId === undefined ? {} : { voiceAssetId: input.voiceAssetId }),
            ...(input.renderAssetId === undefined ? {} : { renderAssetId: input.renderAssetId }),
            ...(input.posterAssetId === undefined ? {} : { posterAssetId: input.posterAssetId }),
            ...(input.caption === undefined ? {} : { caption: input.caption }),
            ...(input.notes === undefined ? {} : { notes: input.notes }),
          },
          actor,
          input.baseVersionId === undefined ? {} : { baseVersionId: input.baseVersionId },
        );
        // A finished render goes on to review, as a render job's result does.
        if (input.renderAssetId !== undefined && written.item.state === "render") {
          const submitted = await content.transition(tx, item.id, "review", actor, {
            via: "submit",
          });
          return { version: written.version, state: submitted.state };
        }
        return { version: written.version, state: written.item.state };
      });
      return {
        versionId: result.version.id,
        versionNo: result.version.versionNo,
        state: result.state,
      };
    },
    summary: ({ versionId, versionNo, state }) =>
      `Saved version ${versionNo} (id ${versionId}); the item is now in ${state}.`,
  });

  return [getRules, createIdea, get, submitForReview];
}
