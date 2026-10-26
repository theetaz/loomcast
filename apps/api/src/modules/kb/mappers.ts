import type { KbEntry, KbEntryDetail, KbReferenceDetail } from "@loomcast/contracts";
import { type KbEntryRow, type KbReferenceRow, kbEntries } from "@loomcast/db";
import { getTableColumns } from "drizzle-orm";

/**
 * Every `kb_entries` column except the generated `search` vector, which is never read back or sent
 * to clients. Use it in every `select` and `returning` of the table.
 */
export const entryColumns = (() => {
  const { search: _search, ...columns } = getTableColumns(kbEntries);
  return columns;
})();

/** A `kb_entries` row as selected with `entryColumns`. */
export type EntryRow = Omit<KbEntryRow, "search">;

export function toKbEntry(row: EntryRow): KbEntry {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    title: row.title,
    bodyMd: row.bodyMd,
    tags: row.tags,
    data: row.data,
    sourceUrl: row.sourceUrl,
    conversationId: row.conversationId,
    createdVia: row.createdVia,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toKbReferenceDetail(row: KbReferenceRow): KbReferenceDetail {
  return {
    url: row.url,
    platform: row.platform,
    author: row.author,
    likedReason: row.likedReason,
    transcript: row.transcript,
    analysis: row.analysis,
    analysisStatus: row.analysisStatus,
    mediaAssetId: row.mediaAssetId,
    analysisJobId: row.analysisJobId,
    analyzedAt: row.analyzedAt?.toISOString() ?? null,
  };
}

/** The detail view: the entry plus its reference part (null for other kinds). */
export function toKbEntryDetail(row: EntryRow, reference: KbReferenceRow | null): KbEntryDetail {
  return {
    ...toKbEntry(row),
    reference:
      row.kind === "reference" && reference !== null ? toKbReferenceDetail(reference) : null,
  };
}
