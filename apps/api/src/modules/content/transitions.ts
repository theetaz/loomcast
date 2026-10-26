import {
  type ContentItem,
  findTransition,
  type PipelineState,
  type TransitionVia,
} from "@loomcast/contracts";
import { type ContentItemRow, type ContentVersionRow, contentItems } from "@loomcast/db";
import { eq, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { ContentStateChange, EventBus } from "../../lib/bus";
import { afterCommit, type Transaction } from "../../lib/db";
import { notFound } from "../../lib/errors";
import { auditActor, type PipelineActor } from "./actor";
import { toContentItem, versionArtifacts } from "./mappers";
import { findItem, findVersion, lockItem } from "./queries";
import { invalidTransition } from "./support";

// The pipeline state machine, applied. `applyTransition` is the only code that writes
// `content_items.state` (a test greps the sources for others): every route, job hook, MCP tool and
// scheduler task moves an item through it, so `PIPELINE_TRANSITIONS` is always enforced, the move
// is audited and `content.item.updated` and `content.item.state_changed` are published after commit.

export interface TransitionOptions {
  /**
   * The version the item ends up on: a version of the item, by default its current one. The move
   * is checked against it (approving and scheduling need a render).
   */
  versionId?: string;
  /** Why, for the audit log and the `content.item.state_changed` event. */
  reason?: string;
  /**
   * The kind of move. Without it any row of `PIPELINE_TRANSITIONS` that allows the move counts;
   * pass it to tell, for example, a user's `approve` from the scheduler's `auto_approve`.
   */
  via?: TransitionVia;
}

export interface ApplyTransitionInput {
  /** The item row, locked by the caller (`lockItem`). */
  item: ContentItemRow;
  to: PipelineState;
  actor: PipelineActor;
  /** The version the item ends up on. */
  version: ContentVersionRow;
  via?: TransitionVia;
  reason?: string | null;
  /** A successful production step clears the last error. */
  clearLastError?: boolean;
}

/**
 * Checks the move against `PIPELINE_TRANSITIONS` with the resulting version, then writes the new
 * state and current version. A refused move is a 409 `invalid_transition`. Entering `archived`
 * stamps `archivedAt` and stops autopilot; leaving it clears `archivedAt`.
 */
export async function applyTransition(
  tx: Transaction,
  bus: EventBus,
  input: ApplyTransitionInput,
): Promise<ContentItem> {
  const { item, to, actor, version } = input;
  const from = item.state;
  const row = findTransition({
    from,
    to,
    actor: actor.kind,
    via: input.via,
    version: versionArtifacts(version),
  });
  if (row === undefined) {
    throw invalidTransition(from, to);
  }

  await tx
    .update(contentItems)
    .set({
      state: to,
      currentVersionId: version.id,
      updatedAt: sql`now()`,
      ...(to === "archived" ? { archivedAt: sql`now()`, autopilotTarget: null } : {}),
      ...(from === "archived" && to !== "archived" ? { archivedAt: null } : {}),
      ...(input.clearLastError === true ? { lastError: null } : {}),
    })
    .where(eq(contentItems.id, item.id));

  if (from !== to) {
    await audit(tx, {
      ...auditActor(actor),
      action: "content.item.transitioned",
      targetType: "content_item",
      targetId: item.id,
      data: { from, to, via: row.via, versionId: version.id, reason: input.reason ?? null },
    });
  }

  const updated = await findItem(tx, item.id);
  if (updated === null) {
    throw new Error("content item vanished during a transition");
  }
  const mapped = toContentItem(updated);
  const change: ContentStateChange = {
    itemId: item.id,
    workspaceId: item.workspaceId,
    from,
    to,
    actor: { kind: actor.kind, id: actor.id },
    versionId: version.id,
    previousVersionId: item.currentVersionId,
    via: row.via,
    reason: input.reason ?? null,
  };
  afterCommit(tx, () => {
    bus.publish({ type: "content.item.updated", payload: { item: mapped } });
    bus.publish({ type: "content.item.state_changed", payload: change });
  });
  return mapped;
}

/**
 * Moves an item to `to` without writing a version: a review decision, submitting a rendered
 * version, archiving, restoring, auto-approval, scheduling and publishing. Locks the item row
 * first. Moving to the state the item is already in, on the same version, changes nothing and
 * publishes nothing. 404 for an unknown item or a version of another item.
 */
export async function transitionItem(
  tx: Transaction,
  bus: EventBus,
  itemId: string,
  to: PipelineState,
  actor: PipelineActor,
  options: TransitionOptions = {},
): Promise<ContentItem> {
  const item = await lockItem(tx, itemId);
  if (item === null) {
    throw notFound("No content item has that id.");
  }
  const versionId = options.versionId ?? item.currentVersionId;
  if (item.state === to && versionId === item.currentVersionId) {
    const current = await findItem(tx, item.id);
    if (current === null) {
      throw notFound("No content item has that id.");
    }
    return toContentItem(current);
  }
  const version = await findVersion(tx, item.id, versionId);
  if (version === null) {
    throw notFound("The item has no version with that id.");
  }
  return applyTransition(tx, bus, {
    item,
    to,
    actor,
    version,
    via: options.via,
    reason: options.reason ?? null,
  });
}
