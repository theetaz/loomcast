import type { Asset, AssetDetail } from "@loomcast/contracts";
import type { AssetRow } from "@loomcast/db";

/** An asset as clients see it. The bucket and storage key never leave the API. */
export function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    projectId: row.projectId,
    itemId: row.itemId,
    kind: row.kind,
    status: row.status,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    probe: row.meta.probe ?? null,
    createdAt: row.createdAt.toISOString(),
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
  };
}

/** An asset with a voice take's word timings. */
export function toAssetDetail(row: AssetRow): AssetDetail {
  return { ...toAsset(row), alignment: row.meta.alignment ?? null };
}
