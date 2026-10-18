import type {
  ContentItem,
  ContentVersion,
  ContentVersionSummary,
  PostFormat,
  VersionArtifacts,
} from "@loomcast/contracts";
import {
  assets,
  type ContentItemRow,
  type ContentVersionRow,
  contentItems,
  contentVersions,
} from "@loomcast/db";
import { getTableColumns, sql } from "drizzle-orm";

/** An item row with the fields derived from its current version and that version's render. */
export interface ItemRow extends ContentItemRow {
  versionNo: number;
  format: PostFormat;
  posterAssetId: string | null;
  durationMs: number | null;
}

/**
 * Columns of `ItemRow`. Select them from `content_items` joined to its current version and, left
 * joined, the version's render asset (`fromItems`).
 */
export const itemColumns = {
  ...getTableColumns(contentItems),
  versionNo: contentVersions.versionNo,
  format: contentVersions.format,
  posterAssetId: contentVersions.posterAssetId,
  durationMs: assets.durationMs,
};

/** A version without its script and storyboard, for timelines. */
export const versionSummaryColumns = {
  id: contentVersions.id,
  itemId: contentVersions.itemId,
  versionNo: contentVersions.versionNo,
  stage: contentVersions.stage,
  parentVersionId: contentVersions.parentVersionId,
  formatVersionId: contentVersions.formatVersionId,
  hasScript: sql<boolean>`${contentVersions.script} is not null`,
  hasStoryboard: sql<boolean>`${contentVersions.storyboard} is not null`,
  format: contentVersions.format,
  media: contentVersions.media,
  voiceAssetId: contentVersions.voiceAssetId,
  renderAssetId: contentVersions.renderAssetId,
  posterAssetId: contentVersions.posterAssetId,
  notes: contentVersions.notes,
  createdVia: contentVersions.createdVia,
  createdByUser: contentVersions.createdByUser,
  jobId: contentVersions.jobId,
  createdAt: contentVersions.createdAt,
};

export type VersionSummaryRow = Omit<ContentVersionRow, "script" | "storyboard" | "caption"> & {
  hasScript: boolean;
  hasStoryboard: boolean;
};

export function toContentItem(row: ItemRow): ContentItem {
  return {
    id: row.id,
    projectId: row.projectId,
    seriesId: row.seriesId,
    title: row.title,
    pitch: row.pitch,
    topic: row.topic,
    state: row.state,
    currentVersionId: row.currentVersionId,
    versionNo: row.versionNo,
    format: row.format,
    durationMs: row.durationMs,
    posterAssetId: row.posterAssetId,
    targetAt: row.targetAt?.toISOString() ?? null,
    autopilotTarget: row.autopilotTarget,
    lastError: row.lastError,
    createdVia: row.createdVia,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

export function toContentVersionSummary(row: VersionSummaryRow): ContentVersionSummary {
  return {
    id: row.id,
    itemId: row.itemId,
    versionNo: row.versionNo,
    stage: row.stage,
    parentVersionId: row.parentVersionId,
    formatVersionId: row.formatVersionId,
    hasScript: row.hasScript,
    hasStoryboard: row.hasStoryboard,
    format: row.format,
    media: row.media,
    voiceAssetId: row.voiceAssetId,
    renderAssetId: row.renderAssetId,
    posterAssetId: row.posterAssetId,
    notes: row.notes,
    createdVia: row.createdVia,
    createdByUser: row.createdByUser,
    jobId: row.jobId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toContentVersion(row: ContentVersionRow): ContentVersion {
  return {
    ...toContentVersionSummary({
      ...row,
      hasScript: row.script !== null,
      hasStoryboard: row.storyboard !== null,
    }),
    script: row.script,
    storyboard: row.storyboard,
    caption: row.caption,
  };
}

/** What the state machine needs to know about a stored version. */
export function versionArtifacts(row: ContentVersionRow): VersionArtifacts {
  return {
    script: row.script,
    storyboard: row.storyboard,
    voiceAssetId: row.voiceAssetId,
    renderAssetId: row.renderAssetId,
    format: row.format,
    media: row.media,
  };
}
