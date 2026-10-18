import { randomUUID } from "node:crypto";
import {
  type ContentItem,
  type CreateReviewRequest,
  type CreateReviewResponse,
  type CursorPage,
  DEFAULT_PAGE_LIMIT,
  formatMediaIssues,
  IdSchema,
  isProducedFormat,
  isPublishable,
  REVIEW_DECISION_STATES,
  type Review,
  type ReviewQueueQuery,
  type TransitionVia,
} from "@loomcast/contracts";
import { contentItems, type Database, type ReviewRow, reviews } from "@loomcast/db";
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, type Transaction } from "../../lib/db";
import { notFound, validationFailed } from "../../lib/errors";
import { auditActor, type PipelineActor } from "../content/actor";
import { toContentItem } from "../content/mappers";
import { findItem, findVersion, lockItem, selectItemsWith } from "../content/queries";
import {
  decodeCursor,
  encodeCursor,
  inTransaction,
  invalidTransition,
  missingArtifact,
  projectExists,
  staleVersion,
} from "../content/support";
import { transitionItem } from "../content/transitions";

export interface ReviewOptions {
  /** Run inside the caller's transaction; events are published when it commits. */
  tx?: Transaction;
}

export interface ReviewsService {
  /**
   * Decides the item's current version, which must be in `review`:
   * - `approve` needs a render (for a composed post, the media its format takes) and moves the
   *   item to `approved`. A user approves; the system
   *   approves on the user's behalf (`auto_approve`) when every post publishes in `auto` mode.
   * - `request_changes` needs a comment and moves the item to `script`. `enqueueRevision`
   *   (default true) is stored for production, which queues `content.revise` on `review.created`.
   * - `reject` archives the item.
   *
   * 409 `invalid_transition` when the item is not in review or the actor may not decide (tokens
   * and devices never approve); 409 `conflict` for a version that is no longer current; 422
   * `missing_artifact` for an approval without a render or media. Publishes `review.created` after commit.
   * Null when there is no such item.
   */
  create(
    itemId: string,
    input: CreateReviewRequest,
    actor: PipelineActor,
    options?: ReviewOptions,
  ): Promise<CreateReviewResponse | null>;
  /** The item's reviews, newest first. Null when there is no such item. */
  list(itemId: string): Promise<Review[] | null>;
  /**
   * Items in `review`, by `targetAt` (soonest first, unscheduled last), then the longest waiting.
   * Null when `projectId` names no project.
   */
  queue(query?: ReviewQueueQuery): Promise<CursorPage<ContentItem> | null>;
}

export interface ReviewsServiceDeps {
  db: Database;
  bus: EventBus;
}

export function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    itemId: row.itemId,
    versionId: row.versionId,
    decision: row.decision,
    comment: row.comment,
    enqueueRevision: row.enqueueRevision,
    userId: row.userId,
    actorKind: row.actorKind,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A timestamp column as fixed-format UTC text with microseconds, for an exact keyset cursor. */
function utcText(column: typeof contentItems.updatedAt | typeof contentItems.targetAt) {
  return sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Rows after the cursor in `target_at ASC NULLS LAST, updated_at ASC, id ASC` order. Items
 * without a target sort after every item with one.
 */
function afterCursor(cursor: { t: string | null; u: string | null; id: string | null }): SQL {
  const rest = sql`(${contentItems.updatedAt}, ${contentItems.id}) > (${cursor.u}::timestamptz, ${cursor.id}::uuid)`;
  if (cursor.t === null) {
    return sql`(${contentItems.targetAt} is null and ${rest})`;
  }
  return sql`(${contentItems.targetAt} is null
    or ${contentItems.targetAt} > ${cursor.t}::timestamptz
    or (${contentItems.targetAt} = ${cursor.t}::timestamptz and ${rest}))`;
}

export function createReviewsService(deps: ReviewsServiceDeps): ReviewsService {
  const { db, bus } = deps;

  return {
    async create(itemId, input, actor, options = {}) {
      if (!IdSchema.safeParse(itemId).success) {
        return null;
      }
      if (input.decision === "request_changes" && !input.comment) {
        throw validationFailed([{ path: "comment", message: "Say what should change" }]);
      }
      return inTransaction(db, options.tx, async (tx) => {
        const item = await lockItem(tx, itemId);
        if (item === null) {
          return null;
        }
        const to = REVIEW_DECISION_STATES[input.decision];
        if (item.state !== "review") {
          throw invalidTransition(item.state, to, "Only an item in review can be decided.");
        }
        if (input.versionId !== item.currentVersionId) {
          throw staleVersion(item.currentVersionId);
        }
        const version = await findVersion(tx, item.id, item.currentVersionId);
        if (version === null) {
          throw notFound("The item has no version with that id.");
        }
        if (input.decision === "approve" && !isPublishable(version)) {
          // A studio video needs its render; a composed post needs the media its format takes.
          throw isProducedFormat(version.format) && version.media.length === 0
            ? missingArtifact("Only a rendered version can be approved.", "render")
            : missingArtifact(formatMediaIssues(version).join(" "), "media");
        }
        const via: TransitionVia =
          input.decision === "approve" && actor.kind === "system" ? "auto_approve" : input.decision;
        const comment = input.comment === undefined || input.comment === "" ? null : input.comment;
        const enqueueRevision =
          input.decision === "request_changes" ? (input.enqueueRevision ?? true) : false;

        const updated = await transitionItem(tx, bus, item.id, to, actor, {
          versionId: version.id,
          via,
          reason: `review:${input.decision}`,
        });
        const [row] = await tx
          .insert(reviews)
          .values({
            id: randomUUID(),
            itemId: item.id,
            versionId: version.id,
            decision: input.decision,
            comment,
            enqueueRevision,
            userId: actor.userId,
            actorKind: actor.kind,
            createdAt: sql`now()`,
          })
          .returning();
        if (row === undefined) {
          throw new Error("review was not inserted");
        }
        await audit(tx, {
          ...auditActor(actor),
          action: "review.created",
          targetType: "content_item",
          targetId: item.id,
          data: {
            reviewId: row.id,
            versionId: version.id,
            decision: input.decision,
            enqueueRevision,
          },
        });
        const review = toReview(row);
        const projectId = item.projectId;
        afterCommit(tx, () =>
          bus.publish({ type: "review.created", payload: { projectId, review } }),
        );
        return { review, item: updated };
      });
    },

    async list(itemId) {
      const item = await findItem(db, itemId);
      if (item === null) {
        return null;
      }
      const rows = await db
        .select()
        .from(reviews)
        .where(eq(reviews.itemId, item.id))
        .orderBy(desc(reviews.createdAt), desc(reviews.id));
      return rows.map(toReview);
    },

    async queue(query = {}) {
      if (query.projectId !== undefined && !(await projectExists(db, query.projectId))) {
        return null;
      }
      const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
      const conditions: (SQL | undefined)[] = [
        eq(contentItems.state, "review"),
        query.projectId === undefined ? undefined : eq(contentItems.projectId, query.projectId),
      ];
      if (query.cursor !== undefined) {
        conditions.push(afterCursor(decodeCursor(query.cursor, ["t", "u", "id"], ["t"])));
      }
      const rows = await queueRows(db, conditions, limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > limit && last !== undefined
          ? encodeCursor({ t: last.cursorTarget, u: last.cursorUpdated, id: last.id })
          : null;
      return {
        items: page.map(({ cursorTarget: _t, cursorUpdated: _u, ...row }) => toContentItem(row)),
        nextCursor,
      };
    },
  };
}

function queueRows(executor: Executor, conditions: (SQL | undefined)[], limit: number) {
  return selectItemsWith(executor, {
    cursorTarget: utcText(contentItems.targetAt),
    cursorUpdated: utcText(contentItems.updatedAt),
  })
    .where(and(...conditions))
    .orderBy(
      sql`${contentItems.targetAt} asc nulls last`,
      asc(contentItems.updatedAt),
      asc(contentItems.id),
    )
    .limit(limit);
}
