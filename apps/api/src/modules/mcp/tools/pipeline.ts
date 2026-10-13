import { type ContentCreatedVia, pipelineTools } from "@loomcast/contracts";
import type { Database } from "@loomcast/db";
import { transaction } from "../../../lib/db";
import type { ContentService, PipelineActor } from "../../content";
import type { FormatsService } from "../../formats";
import { requireActiveProject } from "../../kb/service";
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

/** The project of an `input` tool's call; null means the record it names does not exist. */
function projectOf(ctx: ToolContext, what: string): string {
  if (ctx.projectId === null) {
    throw new McpToolError("not_found", `No ${what} has that id.`);
  }
  return ctx.projectId;
}

/** `format.get_rules` and the `content.*` tools that read and write items and their versions. */
export function createPipelineTools(deps: PipelineToolsDeps): ToolDefinition[] {
  const { db, content, formats, series } = deps;

  /** The project of an item, or null when there is no such item. */
  async function itemProject(itemId: string): Promise<string | null> {
    return (await content.getItem(itemId))?.projectId ?? null;
  }

  /** The item, checked against the project the call was bound to. */
  async function boundItem(itemId: string, ctx: ToolContext) {
    const projectId = projectOf(ctx, "content item");
    const item = await content.getItem(itemId);
    // Checked again: the item may have gone since the binding was resolved.
    if (item === null || item.projectId !== projectId) {
      throw new McpToolError("not_found", "No content item has that id.");
    }
    return item;
  }

  const getRules = defineTool(pipelineTools["format.get_rules"], {
    async resolveProject(input) {
      return (await series.get(input.seriesId))?.projectId ?? null;
    },
    async handler(input, ctx) {
      projectOf(ctx, "series");
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
    resolveProject: async (input) => input.projectId,
    async handler(input, ctx) {
      const projectId = projectOf(ctx, "project");
      const created = await content.create(
        projectId,
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
    resolveProject: (input) => itemProject(input.itemId),
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
    resolveProject: (input) => itemProject(input.itemId),
    async handler(input, ctx) {
      const item = await boundItem(input.itemId, ctx);
      const result = await transaction(db, async (tx) => {
        await requireActiveProject(tx, item.projectId);
        // The state is the stage the new artifacts reach; tokens are never allowed to approve.
        return content.createVersion(
          tx,
          item.id,
          {
            ...(input.script === undefined ? {} : { script: input.script }),
            ...(input.storyboard === undefined ? {} : { storyboard: input.storyboard }),
            ...(input.caption === undefined ? {} : { caption: input.caption }),
            ...(input.notes === undefined ? {} : { notes: input.notes }),
          },
          tokenActor(ctx.caller),
          input.baseVersionId === undefined ? {} : { baseVersionId: input.baseVersionId },
        );
      });
      return {
        versionId: result.version.id,
        versionNo: result.version.versionNo,
        state: result.item.state,
      };
    },
    summary: ({ versionId, versionNo, state }) =>
      `Saved version ${versionNo} (id ${versionId}); the item is now in ${state}.`,
  });

  return [getRules, createIdea, get, submitForReview];
}
