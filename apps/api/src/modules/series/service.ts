import { randomUUID } from "node:crypto";
import {
  type CreateSeriesRequest,
  IdSchema,
  type ListSeriesQuery,
  type Series,
  type SeriesStatus,
  type UpdateSeriesRequest,
} from "@loomcast/contracts";
import { type Database, type SeriesRow, series } from "@loomcast/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import {
  afterCommit,
  type Executor,
  isUniqueViolation,
  type Transaction,
  transaction,
} from "../../lib/db";
import { conflict, validationFailed } from "../../lib/errors";
import { auditActor, type PipelineActor } from "../content/actor";
import { inTransaction, projectExists } from "../content/support";
import { formatOfProject, type WriteOptions } from "../formats/service";
import { freeProjectSlug, nameSlug } from "../formats/slugs";
import { requireActiveProject } from "../kb/service";

export const FALLBACK_SERIES_SLUG = "series";

const SLUG_UNIQUE_CONSTRAINT = "series_project_id_slug_uq";
const SLUG_ATTEMPTS = 5;

/** The status moves of a series and the statuses each one starts from. */
const STATUS_MOVES = {
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  archive: { from: ["active", "paused"], to: "archived" },
} as const satisfies Record<string, { from: readonly SeriesStatus[]; to: SeriesStatus }>;

export type SeriesStatusMove = keyof typeof STATUS_MOVES;

export interface SeriesService {
  /**
   * Creates an active series of a format of the same project. 404 for an unknown project, 409
   * for an archived one or a taken explicit slug, 400 for a format of another project.
   */
  create(projectId: string, input: CreateSeriesRequest, actor: PipelineActor): Promise<Series>;
  get(id: string, executor?: Executor): Promise<Series | null>;
  /** The series of a project by name, optionally of one status. Null for an unknown project. */
  list(projectId: string, query?: ListSeriesQuery): Promise<Series[] | null>;
  /**
   * Renames a series or moves it to another format of the project. 409 for an archived series.
   * Null when there is no such series.
   */
  update(
    id: string,
    input: UpdateSeriesRequest,
    actor: PipelineActor,
    options?: WriteOptions,
  ): Promise<Series | null>;
  /**
   * Pauses (active → paused), resumes (paused → active) or archives a series. A series already in
   * the target status is returned unchanged; pausing or resuming an archived series is a 409.
   * Every change publishes the internal `series.updated` event. Null when there is no such series.
   */
  setStatus(
    id: string,
    move: SeriesStatusMove,
    actor: PipelineActor,
    options?: WriteOptions,
  ): Promise<Series | null>;
}

export interface SeriesServiceDeps {
  db: Database;
  bus: EventBus;
}

export function toSeries(row: SeriesRow): Series {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    slug: row.slug,
    formatId: row.formatId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

const archivedSeries = () => conflict("The series is archived.", { reason: "archived_series" });

async function lockSeries(tx: Transaction, id: string): Promise<SeriesRow | null> {
  const [row] = await tx.select().from(series).where(eq(series.id, id)).limit(1).for("update");
  return row ?? null;
}

async function requireFormat(executor: Executor, projectId: string, formatId: string) {
  const format = await formatOfProject(executor, projectId, formatId);
  if (format === null) {
    throw validationFailed([
      { path: "formatId", message: "No format with that id in this project" },
    ]);
  }
  if (format.archivedAt !== null) {
    throw conflict("The format is archived.", { reason: "archived_format" });
  }
}

export function createSeriesService(deps: SeriesServiceDeps): SeriesService {
  const { db, bus } = deps;

  function publishUpdated(tx: Transaction, before: SeriesRow, after: SeriesRow): void {
    const payload = {
      seriesId: after.id,
      projectId: after.projectId,
      status: after.status,
      previousStatus: before.status,
      formatId: after.formatId,
      previousFormatId: before.formatId,
    };
    afterCommit(tx, () => bus.publish({ type: "series.updated", payload }));
  }

  async function insert(projectId: string, input: CreateSeriesRequest, actor: PipelineActor) {
    return transaction(db, async (tx) => {
      await requireActiveProject(tx, projectId);
      await requireFormat(tx, projectId, input.formatId);
      const slug =
        input.slug ??
        (await freeProjectSlug(
          tx,
          "series",
          projectId,
          nameSlug(input.name, FALLBACK_SERIES_SLUG),
        ));
      const [row] = await tx
        .insert(series)
        .values({
          id: randomUUID(),
          projectId,
          name: input.name,
          slug,
          formatId: input.formatId,
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .returning();
      if (row === undefined) {
        throw new Error("series was not inserted");
      }
      await audit(tx, {
        ...auditActor(actor),
        action: "series.created",
        targetType: "series",
        targetId: row.id,
        data: { projectId, slug, formatId: row.formatId },
      });
      return toSeries(row);
    });
  }

  return {
    async create(projectId, input, actor) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await insert(projectId, input, actor);
        } catch (error) {
          if (!isUniqueViolation(error, SLUG_UNIQUE_CONSTRAINT)) {
            throw error;
          }
          if (input.slug !== undefined) {
            throw conflict("A series of this project already uses that slug.", { field: "slug" });
          }
          if (attempt >= SLUG_ATTEMPTS) {
            throw error;
          }
        }
      }
    },

    async get(id, executor = db) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      const [row] = await executor.select().from(series).where(eq(series.id, id)).limit(1);
      return row === undefined ? null : toSeries(row);
    },

    async list(projectId, query = {}) {
      if (!(await projectExists(db, projectId))) {
        return null;
      }
      const rows = await db
        .select()
        .from(series)
        .where(
          and(
            eq(series.projectId, projectId),
            query.status === undefined ? undefined : eq(series.status, query.status),
          ),
        )
        .orderBy(asc(series.name), asc(series.id));
      return rows.map(toSeries);
    },

    async update(id, input, actor, options = {}) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      return inTransaction(db, options.tx, async (tx) => {
        const before = await lockSeries(tx, id);
        if (before === null) {
          return null;
        }
        if (before.status === "archived") {
          throw archivedSeries();
        }
        if (input.formatId !== undefined && input.formatId !== before.formatId) {
          await requireFormat(tx, before.projectId, input.formatId);
        }
        const [row] = await tx
          .update(series)
          .set({
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.formatId === undefined ? {} : { formatId: input.formatId }),
            updatedAt: sql`now()`,
          })
          .where(eq(series.id, id))
          .returning();
        if (row === undefined) {
          return null;
        }
        await audit(tx, {
          ...auditActor(actor),
          action: "series.updated",
          targetType: "series",
          targetId: id,
          data: {
            fields: [
              ...(input.name === undefined ? [] : ["name"]),
              ...(input.formatId === undefined ? [] : ["formatId"]),
            ],
            formatId: row.formatId,
          },
        });
        publishUpdated(tx, before, row);
        return toSeries(row);
      });
    },

    async setStatus(id, move, actor, options = {}) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      const { from, to } = STATUS_MOVES[move];
      return inTransaction(db, options.tx, async (tx) => {
        const before = await lockSeries(tx, id);
        if (before === null) {
          return null;
        }
        if (before.status === to) {
          return toSeries(before);
        }
        if (!(from as readonly SeriesStatus[]).includes(before.status)) {
          throw archivedSeries();
        }
        const [row] = await tx
          .update(series)
          .set({
            status: to,
            archivedAt: to === "archived" ? sql`now()` : null,
            updatedAt: sql`now()`,
          })
          .where(eq(series.id, id))
          .returning();
        if (row === undefined) {
          return null;
        }
        await audit(tx, {
          ...auditActor(actor),
          action: `series.${to === "active" ? "resumed" : to}`,
          targetType: "series",
          targetId: id,
          data: { from: before.status, to },
        });
        publishUpdated(tx, before, row);
        return toSeries(row);
      });
    },
  };
}
