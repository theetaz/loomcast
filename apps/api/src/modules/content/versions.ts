import { randomUUID } from "node:crypto";
import {
  type AssetKind,
  type ContentItem,
  type ContentVersion,
  type PipelineState,
  type Script,
  type Storyboard,
  stageForArtifacts,
  type TransitionVia,
  type VersionCreatedVia,
} from "@loomcast/contracts";
import {
  type AssetRow,
  type ContentVersionRow,
  contentVersions,
  nextVersionNo,
} from "@loomcast/db";
import { sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, type Transaction } from "../../lib/db";
import { conflict, notFound, validationFailed } from "../../lib/errors";
import { currentFormatVersionId } from "../formats/service";
import { auditActor, type PipelineActor, versionViaFor } from "./actor";
import { toContentItem, toContentVersion, toContentVersionSummary } from "./mappers";
import { findItem, findVersion, findVersionOfJob, lockItem } from "./queries";
import { jsonEqual, staleVersion } from "./support";
import { applyTransition } from "./transitions";

/**
 * What a new version changes. Everything left out is copied forward from the base version, except
 * `notes`, which describe one version. Changing an artifact clears what was made from it:
 * - a changed script clears the voice, render and poster, and the storyboard unless one is given
 *   too (a storyboard is cut against the script's segments), so the item goes back to `script`;
 * - a changed storyboard clears the render and poster;
 * - a changed voice take (a ready `voice` asset of the same item) clears the render and poster.
 */
export interface VersionChanges {
  script?: Script;
  storyboard?: Storyboard;
  voiceAssetId?: string;
  renderAssetId?: string;
  posterAssetId?: string;
  caption?: string | null;
  notes?: string | null;
}

export interface CreateVersionOptions {
  /**
   * The version the change was made on. When it is no longer the current version the write is
   * refused with 409 `conflict` (`details.reason: "stale_version"`). Without it the version
   * builds on the current one.
   */
  baseVersionId?: string;
  /**
   * The state the item moves to. By default the stage the artifacts reach
   * (`stageForArtifacts`), or the current state for a caption or notes change in `review` or
   * `approved`. A render result may pass `review` to submit in the same step.
   */
  state?: PipelineState;
  /** The kind of move; derived from the states when left out. */
  via?: TransitionVia;
  /** Defaults by actor kind: user `ui`, token `mcp`, device `job`, system `system`. */
  createdVia?: VersionCreatedVia;
  /** The job whose result this is. A second version for the same job is never written. */
  jobId?: string | null;
  /** The format version it was produced with; defaults to the series' current one. */
  formatVersionId?: string | null;
  reason?: string;
}

export interface VersionResult {
  item: ContentItem;
  version: ContentVersion;
  /** False when the job already had a version, which is returned unchanged. */
  created: boolean;
}

export interface VersionDeps {
  bus: EventBus;
  /** Reads asset rows, to check that a voice, render or poster belongs to the item. */
  assets: { getRow(id: string, executor?: Executor): Promise<AssetRow | null> };
}

interface Artifacts {
  script: Script | null;
  storyboard: Storyboard | null;
  voiceAssetId: string | null;
  renderAssetId: string | null;
  posterAssetId: string | null;
  caption: string | null;
  notes: string | null;
}

/** The artifacts of a new version on top of `base`, with the invalidation rules applied. */
export function applyChanges(base: ContentVersionRow, changes: VersionChanges): Artifacts {
  const next: Artifacts = {
    script: base.script,
    storyboard: base.storyboard,
    voiceAssetId: base.voiceAssetId,
    renderAssetId: base.renderAssetId,
    posterAssetId: base.posterAssetId,
    caption: changes.caption === undefined ? base.caption : changes.caption,
    notes: changes.notes ?? null,
  };
  if (changes.script !== undefined && !jsonEqual(changes.script, base.script)) {
    next.script = changes.script;
    next.voiceAssetId = null;
    next.renderAssetId = null;
    next.posterAssetId = null;
    if (changes.storyboard === undefined) {
      next.storyboard = null;
    }
  }
  if (changes.storyboard !== undefined && !jsonEqual(changes.storyboard, base.storyboard)) {
    next.storyboard = changes.storyboard;
    next.renderAssetId = null;
    next.posterAssetId = null;
  }
  if (changes.voiceAssetId !== undefined && changes.voiceAssetId !== base.voiceAssetId) {
    next.voiceAssetId = changes.voiceAssetId;
    next.renderAssetId = null;
    next.posterAssetId = null;
  }
  if (changes.renderAssetId !== undefined) {
    next.renderAssetId = changes.renderAssetId;
  }
  if (changes.posterAssetId !== undefined) {
    next.posterAssetId = changes.posterAssetId;
  }
  return next;
}

function artifactsChanged(base: ContentVersionRow, next: Artifacts): boolean {
  return (
    !jsonEqual(base.script, next.script) ||
    !jsonEqual(base.storyboard, next.storyboard) ||
    base.voiceAssetId !== next.voiceAssetId ||
    base.renderAssetId !== next.renderAssetId ||
    base.posterAssetId !== next.posterAssetId
  );
}

/** The state a new version puts the item in, unless the caller names one. */
function targetState(from: PipelineState, base: ContentVersionRow, next: Artifacts): PipelineState {
  if ((from === "review" || from === "approved") && !artifactsChanged(base, next)) {
    return from;
  }
  return stageForArtifacts(next);
}

function moveKind(from: PipelineState, to: PipelineState): TransitionVia {
  if (from === "approved") return "edit";
  if (to === "review" && from !== "review") return "submit";
  return "version";
}

const ASSET_FIELDS = [
  ["voiceAssetId", "voice"],
  ["renderAssetId", "render"],
  ["posterAssetId", "poster"],
] as const satisfies readonly (readonly [keyof Artifacts, AssetKind])[];

/** New asset references must be ready assets of the right kind that belong to the item. */
async function requireItemAssets(
  tx: Transaction,
  deps: VersionDeps,
  itemId: string,
  base: ContentVersionRow,
  next: Artifacts,
): Promise<void> {
  for (const [field, kind] of ASSET_FIELDS) {
    const id = next[field];
    if (id === null || id === base[field]) {
      continue;
    }
    const asset = await deps.assets.getRow(id, tx);
    if (asset === null || asset.itemId !== itemId || asset.kind !== kind) {
      throw validationFailed([
        { path: field, message: `No ${kind} asset with that id on this item` },
      ]);
    }
    if (asset.status !== "ready") {
      throw validationFailed([{ path: field, message: `The ${kind} asset is not ready` }]);
    }
  }
}

/**
 * Writes the next version of an item on top of its current version and moves the item to the
 * state it reaches, through `applyTransition`. Must run in a transaction opened with
 * `transaction()` (or one passed down from it): `nextVersionNo` locks the item row until it
 * commits, and the events are published once it does.
 *
 * With `jobId`, a job whose result was already stored gets its existing version back
 * (`created: false`), so a replayed completion never writes a second version.
 */
export async function createVersion(
  tx: Transaction,
  deps: VersionDeps,
  itemId: string,
  changes: VersionChanges,
  actor: PipelineActor,
  options: CreateVersionOptions = {},
): Promise<VersionResult> {
  // Locks the item row: writers of one item queue up, and each sees the versions before it.
  const versionNo = await nextVersionNo(tx, itemId);
  const item = versionNo === null ? null : await lockItem(tx, itemId);
  if (versionNo === null || item === null) {
    throw notFound("No content item has that id.");
  }

  const jobId = options.jobId ?? null;
  if (jobId !== null) {
    const existing = await findVersionOfJob(tx, jobId);
    if (existing !== null) {
      return existingResult(tx, itemId, existing);
    }
  }
  if (options.baseVersionId !== undefined && options.baseVersionId !== item.currentVersionId) {
    throw staleVersion(item.currentVersionId);
  }
  const base = await findVersion(tx, item.id, item.currentVersionId);
  if (base === null) {
    throw new Error("content item without its current version");
  }

  const next = applyChanges(base, changes);
  await requireItemAssets(tx, deps, item.id, base, next);
  const to = options.state ?? targetState(item.state, base, next);
  const via = options.via ?? moveKind(item.state, to);
  const formatVersionId =
    options.formatVersionId !== undefined
      ? options.formatVersionId
      : await currentFormatVersionId(tx, item.seriesId);

  const [inserted] = await tx
    .insert(contentVersions)
    .values({
      id: randomUUID(),
      itemId: item.id,
      versionNo,
      stage: to,
      parentVersionId: base.id,
      formatVersionId,
      ...next,
      createdVia: options.createdVia ?? versionViaFor(actor),
      createdByUser: actor.userId,
      jobId,
      createdAt: sql`now()`,
    })
    .onConflictDoNothing({
      target: contentVersions.jobId,
      where: sql`${contentVersions.jobId} is not null`,
    })
    .returning();
  if (inserted === undefined) {
    // Only the job id can conflict here: the item lock serialises version numbers.
    const existing = jobId === null ? null : await findVersionOfJob(tx, jobId);
    if (existing === null) {
      throw new Error("content version was not inserted");
    }
    return existingResult(tx, itemId, existing);
  }

  await audit(tx, {
    ...auditActor(actor),
    action: "content.version.created",
    targetType: "content_item",
    targetId: item.id,
    data: { versionId: inserted.id, versionNo, stage: to, via, jobId },
  });
  const summary = toContentVersionSummary({
    ...inserted,
    hasScript: inserted.script !== null,
    hasStoryboard: inserted.storyboard !== null,
  });
  afterCommit(tx, () =>
    deps.bus.publish({
      type: "content.version.created",
      payload: { projectId: item.projectId, version: summary },
    }),
  );
  const updated = await applyTransition(tx, deps.bus, {
    item,
    to,
    actor,
    version: inserted,
    via,
    reason: options.reason ?? null,
    clearLastError: true,
  });
  return { item: updated, version: toContentVersion(inserted), created: true };
}

async function existingResult(
  tx: Transaction,
  itemId: string,
  version: ContentVersionRow,
): Promise<VersionResult> {
  if (version.itemId !== itemId) {
    throw conflict("The job's result was stored on another item.", { reason: "job_item_mismatch" });
  }
  const item = await findItem(tx, itemId);
  if (item === null) {
    throw notFound("No content item has that id.");
  }
  return { item: toContentItem(item), version: toContentVersion(version), created: false };
}
