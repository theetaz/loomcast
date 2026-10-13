import { pipelineTools } from "@loomcast/contracts";
import { HttpError } from "../../../lib/errors";
import type { AssetActor, AssetsService } from "../../assets/service";
import type { ContentService } from "../../content";
import type { McpCaller } from "../caller";
import { defineTool, McpToolError, type ToolContext, type ToolDefinition } from "./registry";

export interface AssetToolsDeps {
  assets: AssetsService;
  content: Pick<ContentService, "getItem">;
}

/**
 * Conflicts a client acts on, reported under their own code so a producer session can tell them
 * apart: `upload_missing` (PUT the bytes, then finalize again) and `not_ready` (the asset is still
 * uploading or failed).
 */
const REASON_CODES = new Set(["upload_missing", "not_ready"]);

/** The token acting for its user; a job token also names its job (`created_by_job`). */
function assetActor(caller: McpCaller): AssetActor {
  return {
    kind: "token",
    id: caller.token.id,
    userId: caller.token.user.id,
    jobId: caller.jobId,
    ip: caller.ip,
  };
}

/**
 * The asset service's failures in MCP terms: the conflicts above get their reason as the code,
 * and missing object storage is reported as such instead of as an internal error.
 */
function toToolError(error: unknown): unknown {
  if (!(error instanceof HttpError)) {
    return error;
  }
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  if (error.status === 409 && typeof reason === "string" && REASON_CODES.has(reason)) {
    return new McpToolError(reason, error.message);
  }
  if (error.code === "storage_unavailable") {
    return new McpToolError(error.code, error.message);
  }
  return error;
}

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toToolError(error);
  }
}

/** `content.upload_asset`, `content.finalize_asset` and `asset.get_url`. */
export function createAssetTools(deps: AssetToolsDeps): ToolDefinition[] {
  const { assets, content } = deps;

  /** The project of an asset, or null when there is no such asset. */
  async function assetProject(assetId: string): Promise<string | null> {
    return (await assets.getRow(assetId))?.projectId ?? null;
  }

  /** The asset's row, checked against the project the call was bound to. */
  async function boundAsset(assetId: string, ctx: ToolContext) {
    const row = ctx.projectId === null ? null : await assets.getRow(assetId);
    if (row === null || row.projectId !== ctx.projectId) {
      throw new McpToolError("not_found", "No asset has that id.");
    }
    return row;
  }

  const upload = defineTool(pipelineTools["content.upload_asset"], {
    async resolveProject(input) {
      return (await content.getItem(input.itemId))?.projectId ?? null;
    },
    async handler(input, ctx) {
      if (ctx.projectId === null) {
        throw new McpToolError("not_found", "No content item has that id.");
      }
      const projectId = ctx.projectId;
      const { asset, upload: instructions } = await mapErrors(() =>
        assets.createUpload(
          {
            projectId,
            itemId: input.itemId,
            kind: input.kind,
            filename: input.filename,
            mime: input.mime,
            bytes: input.bytes,
            sha256: input.sha256,
          },
          assetActor(ctx.caller),
        ),
      );
      return { asset, upload: instructions };
    },
    summary: ({ asset, upload }) =>
      upload === null
        ? `Asset ${asset.id} (${asset.kind}) is already stored and ready; no upload needed.`
        : `Asset ${asset.id} (${asset.kind}) is waiting for its upload: PUT the bytes with the ` +
          `returned headers before ${upload.expiresAt}, then call content.finalize_asset.`,
  });

  const finalize = defineTool(pipelineTools["content.finalize_asset"], {
    resolveProject: (input) => assetProject(input.assetId),
    async handler(input, ctx) {
      await boundAsset(input.assetId, ctx);
      const asset = await mapErrors(() =>
        assets.finalize(
          input.assetId,
          {
            ...(input.probe === undefined ? {} : { probe: input.probe }),
            ...(input.alignment === undefined ? {} : { alignment: input.alignment }),
          },
          assetActor(ctx.caller),
        ),
      );
      if (asset === null) {
        throw new McpToolError("not_found", "No asset has that id.");
      }
      return { asset };
    },
    summary: ({ asset }) =>
      asset.status === "ready"
        ? `Asset ${asset.id} (${asset.kind}) is ready.`
        : `Asset ${asset.id} (${asset.kind}) failed verification: the stored bytes did not ` +
          "match the size or SHA-256. Start a new upload.",
  });

  const getUrl = defineTool(pipelineTools["asset.get_url"], {
    resolveProject: (input) => assetProject(input.assetId),
    async handler(input, ctx) {
      await boundAsset(input.assetId, ctx);
      const signed = await mapErrors(() =>
        assets.url(
          input.assetId,
          input.disposition === undefined ? {} : { disposition: input.disposition },
        ),
      );
      const asset = await assets.get(input.assetId);
      if (signed === null || asset === null) {
        throw new McpToolError("not_found", "No asset has that id.");
      }
      return { url: signed.url, expiresAt: signed.expiresAt, asset };
    },
    summary: ({ asset, expiresAt }) =>
      `Download URL for asset ${asset.id} (${asset.kind}, ${asset.bytes} bytes), valid until ` +
      `${expiresAt}.`,
  });

  return [upload, finalize, getUrl];
}
