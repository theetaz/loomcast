import { randomUUID } from "node:crypto";
import {
  type ContentCreatedVia,
  type ContentItem,
  type ContentItemDetail,
  type ContentItemError,
  type ContentVersion,
  type ContentVersionSummary,
  type CreateContentItemRequest,
  type CursorPage,
  DEFAULT_PAGE_LIMIT,
  type EditVersionRequest,
  type EditVersionResponse,
  type FormatSnapshot,
  FormatSnapshotSchema,
  IdSchema,
  type ListContentQuery,
  type PipelineState,
  type ProduceTarget,
  type UpdateContentItemRequest,
} from "@loomcast/contracts";
import {
  type AssetRow,
  contentItems,
  contentVersions,
  type Database,
  escapeLikePattern,
  type JobRow,
  jobs,
  series,
} from "@loomcast/db";
import { and, desc, eq, gte, ilike, inArray, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, type Transaction } from "../../lib/db";
import { conflict, notFound, validationFailed } from "../../lib/errors";
import { createFormatsService, currentFormatVersionId } from "../formats/service";
import { toJobSummary } from "../jobs/service";
import { requireActiveProject } from "../kb/service";
import { auditActor, itemViaFor, type PipelineActor } from "./actor";
import { toContentItem, toContentVersion, toContentVersionSummary } from "./mappers";
import {
  activeProductionJob,
  findItem,
  findVersion,
  lockItem,
  selectItemsWith,
  versionSummaries,
} from "./queries";
import { decodeCursor, encodeCursor, inTransaction, projectExists } from "./support";
import { type TransitionOptions, transitionItem } from "./transitions";
import {
  type CreateVersionOptions,
  createVersion,
  type VersionChanges,
  type VersionResult,
} from "./versions";

export interface WriteOptions {
  /** Run inside the caller's transaction; events are published when it commits. */
  tx?: Transaction;
}

export interface CreateItemOptions extends WriteOptions {
  /** Defaults by actor kind; a producer session's job token passes `producer`. */
  createdVia?: ContentCreatedVia;
}

/** Item fields production and the calendar maintain. None of them is the state. */
export interface ItemTracking {
  /** Where autopilot stops; null turns it off. */
  autopilotTarget?: ProduceTarget | null;
  /** The last production failure; null clears it. */
  lastError?: ContentItemError | null;
  targetAt?: Date | null;
}

export interface JobVersionOptions extends Omit<CreateVersionOptions, "jobId" | "createdVia"> {
  /** Defaults to the device that ran the job, acting for the user who started it. */
  actor?: PipelineActor;
}

export interface ContentService {
  /**
   * Creates an idea: the item in state `idea` and its version 1 in one transaction, then
   * publishes `content.item.created`. 404 for an unknown project, 409 for an archived project or
   * series, 400 for a series of another project.
   */
  create(
    projectId: string,
    input: CreateContentItemRequest,
    actor: PipelineActor,
    options?: CreateItemOptions,
  ): Promise<ContentItemDetail>;
  /** The item, its current version, its version timeline and its active job; or null. */
  get(id: string, executor?: Executor): Promise<ContentItemDetail | null>;
  /** Just the item, or null. */
  getItem(id: string, executor?: Executor): Promise<ContentItem | null>;
  /**
   * Items, most recently updated first, by keyset cursor. Archived items are left out unless
   * `states` asks for them. Null when `projectId` names no project.
   */
  list(query?: ListContentQuery): Promise<CursorPage<ContentItem> | null>;
  /** Changes the title or pitch (no new version). Null when there is no such item. */
  update(
    id: string,
    input: UpdateContentItemRequest,
    actor: PipelineActor,
    options?: WriteOptions,
  ): Promise<ContentItem | null>;
  /** Every version, newest first. Null when there is no such item. */
  versions(id: string): Promise<ContentVersionSummary[] | null>;
  /** One version of the item, or null. */
  getVersion(
    itemId: string,
    versionId: string,
    executor?: Executor,
  ): Promise<ContentVersion | null>;
  /**
   * A user's edit in the web app: a new version on `baseVersionId`, which must be current
   * (409 `conflict` otherwise). 409 `invalid_transition` when the state machine refuses the move,
   * for example while the item is scheduled. 404 for an unknown item.
   */
  edit(id: string, input: EditVersionRequest, actor: PipelineActor): Promise<EditVersionResponse>;
  /** Writes a version in the caller's transaction; see `createVersion` in `versions.ts`. */
  createVersion(
    tx: Transaction,
    itemId: string,
    changes: VersionChanges,
    actor: PipelineActor,
    options?: CreateVersionOptions,
  ): Promise<VersionResult>;
  /**
   * Stores a production job's result as a new version, idempotently: a job that already has a
   * version gets it back (`created: false`). The actor defaults to the device that ran the job,
   * and the format version to the one in the job's payload.
   */
  createVersionFromJob(
    tx: Transaction,
    jobId: string,
    itemId: string,
    artifacts: VersionChanges,
    options?: JobVersionOptions,
  ): Promise<VersionResult>;
  /**
   * Moves an item without a new version (review decisions, submit, archive, restore,
   * auto-approval, schedule, publish). Locks the row, checks `PIPELINE_TRANSITIONS` against the
   * resulting version, audits, and publishes `content.item.updated` and the internal
   * `content.item.state_changed` after commit. 409 `invalid_transition` when refused.
   */
  transition(
    tx: Transaction,
    itemId: string,
    to: PipelineState,
    actor: PipelineActor,
    options?: TransitionOptions,
  ): Promise<ContentItem>;
  /** Takes an item out of the pipeline (a user's move). Archiving an archived item is a no-op. */
  archive(id: string, actor: PipelineActor, options?: WriteOptions): Promise<ContentItem>;
  /** Brings an archived item back as an idea (a user's move). */
  restore(id: string, actor: PipelineActor, options?: WriteOptions): Promise<ContentItem>;
  /**
   * Sets autopilot, the last error or the target time and publishes `content.item.updated`.
   * Null when there is no such item.
   */
  track(tx: Transaction, itemId: string, fields: ItemTracking): Promise<ContentItem | null>;
  /** The production job queued or running for the item, if any. */
  activeJob(itemId: string, executor?: Executor): Promise<JobRow | null>;
  /**
   * The format an item is produced with: its series' current format version and rules. Null for
   * an item without a series (production then uses `DEFAULT_FORMAT_RULES`) or no such item.
   */
  formatSnapshot(itemId: string, executor?: Executor): Promise<FormatSnapshot | null>;
}

export interface ContentServiceDeps {
  db: Database;
  bus: EventBus;
  assets: { getRow(id: string, executor?: Executor): Promise<AssetRow | null> };
}

const itemNotFound = () => notFound("No content item has that id.");

/** `updated_at` as fixed-format UTC text with microseconds, for an exact keyset cursor. */
const cursorUpdatedAt = sql<string>`to_char(${contentItems.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Empty pitches are stored as null. */
function normalisePitch(pitch: string | null | undefined): string | null | undefined {
  return pitch === "" ? null : pitch;
}

/** The series of a new item: in the same project and not archived. */
async function requireSeries(tx: Transaction, projectId: string, seriesId: string): Promise<void> {
  const [row] = await tx
    .select({ status: series.status })
    .from(series)
    .where(and(eq(series.id, seriesId), eq(series.projectId, projectId)))
    .limit(1)
    .for("share");
  if (row === undefined) {
    throw validationFailed([
      { path: "seriesId", message: "No series with that id in this project" },
    ]);
  }
  if (row.status === "archived") {
    throw conflict("The series is archived.", { reason: "archived_series" });
  }
}

export function createContentService(deps: ContentServiceDeps): ContentService {
  const { db, bus } = deps;
  const formats = createFormatsService(deps);

  async function detail(executor: Executor, id: string): Promise<ContentItemDetail | null> {
    const item = await findItem(executor, id);
    if (item === null) {
      return null;
    }
    // One after another: a transaction is a single connection.
    const current = await findVersion(executor, item.id, item.currentVersionId);
    const summaries = await versionSummaries(executor, item.id);
    const job = await activeProductionJob(executor, item);
    if (current === null) {
      throw new Error("content item without its current version");
    }
    return {
      item: toContentItem(item),
      currentVersion: toContentVersion(current),
      versions: summaries.map(toContentVersionSummary),
      activeJob: job === null ? null : toJobSummary(job),
    };
  }

  async function mappedItem(executor: Executor, id: string): Promise<ContentItem> {
    const row = await findItem(executor, id);
    if (row === null) {
      throw itemNotFound();
    }
    return toContentItem(row);
  }

  function publishUpdated(tx: Transaction, item: ContentItem): void {
    afterCommit(tx, () => bus.publish({ type: "content.item.updated", payload: { item } }));
  }

  async function move(
    id: string,
    to: PipelineState,
    actor: PipelineActor,
    via: "archive" | "restore",
    options: WriteOptions,
  ): Promise<ContentItem> {
    if (!IdSchema.safeParse(id).success) {
      throw itemNotFound();
    }
    return inTransaction(db, options.tx, (tx) => transitionItem(tx, bus, id, to, actor, { via }));
  }

  return {
    async create(projectId, input, actor, options = {}) {
      return inTransaction(db, options.tx, async (tx) => {
        await requireActiveProject(tx, projectId);
        if (input.seriesId !== undefined) {
          await requireSeries(tx, projectId, input.seriesId);
        }
        const itemId = randomUUID();
        const versionId = randomUUID();
        // The current-version foreign key is deferred: the item goes in first, then version 1.
        await tx.insert(contentItems).values({
          id: itemId,
          projectId,
          seriesId: input.seriesId ?? null,
          title: input.title,
          pitch: normalisePitch(input.pitch) ?? null,
          topic: input.topic ?? null,
          state: "idea",
          currentVersionId: versionId,
          targetAt: input.targetAt === undefined ? null : new Date(input.targetAt),
          createdVia: options.createdVia ?? itemViaFor(actor),
          createdBy: actor.userId,
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
        });
        await tx.insert(contentVersions).values({
          id: versionId,
          itemId,
          versionNo: 1,
          stage: "idea",
          format: input.format ?? "reel",
          formatVersionId: await currentFormatVersionId(tx, input.seriesId ?? null),
          createdVia: "system",
          createdByUser: actor.userId,
          createdAt: sql`now()`,
        });
        await audit(tx, {
          ...auditActor(actor),
          action: "content.item.created",
          targetType: "content_item",
          targetId: itemId,
          data: { projectId, seriesId: input.seriesId ?? null, versionId },
        });
        const created = await detail(tx, itemId);
        if (created === null) {
          throw new Error("content item was not inserted");
        }
        const item = created.item;
        afterCommit(tx, () => bus.publish({ type: "content.item.created", payload: { item } }));
        return created;
      });
    },

    get: (id, executor = db) => detail(executor, id),

    async getItem(id, executor = db) {
      const row = await findItem(executor, id);
      return row === null ? null : toContentItem(row);
    },

    async list(query = {}) {
      if (query.projectId !== undefined && !(await projectExists(db, query.projectId))) {
        return null;
      }
      const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
      const conditions: (SQL | undefined)[] = [
        query.projectId === undefined ? undefined : eq(contentItems.projectId, query.projectId),
        query.states === undefined
          ? ne(contentItems.state, "archived")
          : inArray(contentItems.state, query.states),
        query.seriesId === undefined ? undefined : eq(contentItems.seriesId, query.seriesId),
        query.targetFrom === undefined
          ? undefined
          : gte(contentItems.targetAt, new Date(query.targetFrom)),
        query.targetTo === undefined
          ? undefined
          : lte(contentItems.targetAt, new Date(query.targetTo)),
      ];
      if (query.q !== undefined) {
        const pattern = `%${escapeLikePattern(query.q)}%`;
        conditions.push(or(ilike(contentItems.title, pattern), ilike(contentItems.pitch, pattern)));
      }
      if (query.cursor !== undefined) {
        const cursor = decodeCursor(query.cursor, ["u", "id"]);
        conditions.push(
          sql`(${contentItems.updatedAt}, ${contentItems.id}) < (${cursor.u}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      const rows = await selectItemsWith(db, { cursorAt: cursorUpdatedAt })
        .where(and(...conditions))
        .orderBy(desc(contentItems.updatedAt), desc(contentItems.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > limit && last !== undefined
          ? encodeCursor({ u: last.cursorAt, id: last.id })
          : null;
      return {
        items: page.map(({ cursorAt: _cursorAt, ...row }) => toContentItem(row)),
        nextCursor,
      };
    },

    async update(id, input, actor, options = {}) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      return inTransaction(db, options.tx, async (tx) => {
        const existing = await lockItem(tx, id);
        if (existing === null) {
          return null;
        }
        const pitch = normalisePitch(input.pitch);
        await tx
          .update(contentItems)
          .set({
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(pitch === undefined ? {} : { pitch }),
            updatedAt: sql`now()`,
          })
          .where(eq(contentItems.id, id));
        await audit(tx, {
          ...auditActor(actor),
          action: "content.item.updated",
          targetType: "content_item",
          targetId: id,
          data: {
            fields: [
              ...(input.title === undefined ? [] : ["title"]),
              ...(pitch === undefined ? [] : ["pitch"]),
            ],
          },
        });
        const item = await mappedItem(tx, id);
        publishUpdated(tx, item);
        return item;
      });
    },

    async versions(id) {
      const item = await findItem(db, id);
      if (item === null) {
        return null;
      }
      return (await versionSummaries(db, item.id)).map(toContentVersionSummary);
    },

    async getVersion(itemId, versionId, executor = db) {
      if (!IdSchema.safeParse(itemId).success) {
        return null;
      }
      const row = await findVersion(executor, itemId, versionId);
      return row === null ? null : toContentVersion(row);
    },

    async edit(id, input, actor) {
      const { baseVersionId, ...changes } = input;
      return inTransaction(db, undefined, async (tx) => {
        const existing = await findItem(tx, id);
        if (existing === null) {
          throw itemNotFound();
        }
        await requireActiveProject(tx, existing.projectId);
        const result = await createVersion(tx, deps, id, changes, actor, { baseVersionId });
        return { item: result.item, version: result.version };
      });
    },

    createVersion: (tx, itemId, changes, actor, options) =>
      createVersion(tx, deps, itemId, changes, actor, options),

    async createVersionFromJob(tx, jobId, itemId, artifacts, options = {}) {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (job === undefined) {
        throw notFound("No job has that id.");
      }
      const { actor: actorOverride, ...rest } = options;
      const actor: PipelineActor = actorOverride ?? {
        kind: "device",
        id: job.claimedByDevice,
        userId: job.createdBy,
      };
      if (job.payload.itemId !== itemId) {
        throw validationFailed([{ path: "itemId", message: "The job is for another item" }]);
      }
      const format = FormatSnapshotSchema.shape.formatVersionId.safeParse(
        (job.payload.format as { formatVersionId?: unknown } | undefined)?.formatVersionId,
      );
      return createVersion(tx, deps, itemId, artifacts, actor, {
        ...(format.success ? { formatVersionId: format.data } : {}),
        ...rest,
        jobId,
        createdVia: "job",
      });
    },

    transition: (tx, itemId, to, actor, options) =>
      transitionItem(tx, bus, itemId, to, actor, options),

    archive: (id, actor, options = {}) => move(id, "archived", actor, "archive", options),

    restore: (id, actor, options = {}) => move(id, "idea", actor, "restore", options),

    async track(tx, itemId, fields) {
      const existing = await lockItem(tx, itemId);
      if (existing === null) {
        return null;
      }
      await tx
        .update(contentItems)
        .set({
          ...(fields.autopilotTarget === undefined
            ? {}
            : { autopilotTarget: fields.autopilotTarget }),
          ...(fields.lastError === undefined ? {} : { lastError: fields.lastError }),
          ...(fields.targetAt === undefined ? {} : { targetAt: fields.targetAt }),
          updatedAt: sql`now()`,
        })
        .where(eq(contentItems.id, itemId));
      const item = await mappedItem(tx, itemId);
      publishUpdated(tx, item);
      return item;
    },

    async activeJob(itemId, executor = db) {
      const item = await findItem(executor, itemId);
      return item === null ? null : activeProductionJob(executor, item);
    },

    async formatSnapshot(itemId, executor = db) {
      const item = await findItem(executor, itemId);
      if (item === null || item.seriesId === null) {
        return null;
      }
      return formats.snapshotForSeries(item.seriesId, executor);
    },
  };
}
