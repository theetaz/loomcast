import { randomUUID } from "node:crypto";
import {
  type CreateFormatRequest,
  DEFAULT_FORMAT_RULES,
  type Format,
  type FormatGetRulesOutput,
  type FormatSnapshot,
  type FormatVersion,
  IdSchema,
  type UpdateFormatRequest,
} from "@loomcast/contracts";
import {
  type Database,
  type FormatRow,
  type FormatVersionRow,
  formats,
  formatVersions,
  nextFormatVersionNo,
  series,
} from "@loomcast/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, isUniqueViolation, type Transaction } from "../../lib/db";
import { conflict } from "../../lib/errors";
import { auditActor, type PipelineActor } from "../content/actor";
import { inTransaction, workspaceExists } from "../content/support";
import { requireActiveWorkspace } from "../kb/service";
import { freeWorkspaceSlug, nameSlug } from "./slugs";

/** Slug used when a name leaves nothing usable. */
export const FALLBACK_FORMAT_SLUG = "format";

const SLUG_UNIQUE_CONSTRAINT = "formats_workspace_id_slug_uq";

/** Attempts at a derived slug when parallel creates of other names keep taking it. */
const SLUG_ATTEMPTS = 5;

export interface WriteOptions {
  /** Run inside the caller's transaction; events are published when it commits. */
  tx?: Transaction;
}

export interface FormatsService {
  /**
   * Creates a format with version 1 (`DEFAULT_FORMAT_RULES` unless `rules` is given). 404 for an
   * unknown workspace, 409 for an archived one or a taken explicit slug.
   */
  create(workspaceId: string, input: CreateFormatRequest, actor: PipelineActor): Promise<Format>;
  /** A format with its current version, or null. */
  get(id: string, executor?: Executor): Promise<Format | null>;
  /** The formats of a workspace by name. Null when the workspace is unknown. */
  list(workspaceId: string): Promise<Format[] | null>;
  /**
   * Stores a new version (even for a rename) and moves `currentVersionId`, then publishes the
   * internal `format.updated` event. 409 `conflict` when `baseVersionId` is not the current
   * version. Null when there is no such format.
   */
  update(
    id: string,
    input: UpdateFormatRequest,
    actor: PipelineActor,
    options?: WriteOptions,
  ): Promise<Format | null>;
  /** Every version, newest first. Null when there is no such format. */
  versions(id: string): Promise<FormatVersion[] | null>;
  /** One version by id, or null. */
  getVersion(versionId: string, executor?: Executor): Promise<FormatVersion | null>;
  /**
   * The current format version of a series as a job snapshot (`FormatSnapshot`). Null when there
   * is no such series.
   */
  snapshotForSeries(seriesId: string, executor?: Executor): Promise<FormatSnapshot | null>;
  /** The current rules of a series' format, as the MCP `format.get_rules` tool returns them. */
  rulesForSeries(seriesId: string, executor?: Executor): Promise<FormatGetRulesOutput | null>;
}

export interface FormatsServiceDeps {
  db: Database;
  bus: EventBus;
}

export function toFormatVersion(row: FormatVersionRow): FormatVersion {
  return {
    id: row.id,
    formatId: row.formatId,
    versionNo: row.versionNo,
    rules: row.rules,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toFormat(row: FormatRow, version: FormatVersionRow): Format {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    currentVersion: toFormatVersion(version),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/** Formats joined with their current version. */
function selectFormats(executor: Executor) {
  return executor
    .select({ format: formats, version: formatVersions })
    .from(formats)
    .innerJoin(formatVersions, eq(formatVersions.id, formats.currentVersionId));
}

/** The current format version of a series, with its format. */
async function seriesFormat(executor: Executor, seriesId: string) {
  if (!IdSchema.safeParse(seriesId).success) {
    return null;
  }
  const [row] = await executor
    .select({ format: formats, version: formatVersions })
    .from(series)
    .innerJoin(formats, eq(formats.id, series.formatId))
    .innerJoin(formatVersions, eq(formatVersions.id, formats.currentVersionId))
    .where(eq(series.id, seriesId))
    .limit(1);
  return row ?? null;
}

/** The id of the current format version of a series, or null for no series. */
export async function currentFormatVersionId(
  executor: Executor,
  seriesId: string | null,
): Promise<string | null> {
  if (seriesId === null) {
    return null;
  }
  const row = await seriesFormat(executor, seriesId);
  return row?.version.id ?? null;
}

export function createFormatsService(deps: FormatsServiceDeps): FormatsService {
  const { db, bus } = deps;

  async function get(id: string, executor: Executor = db): Promise<Format | null> {
    if (!IdSchema.safeParse(id).success) {
      return null;
    }
    const [row] = await selectFormats(executor).where(eq(formats.id, id)).limit(1);
    return row === undefined ? null : toFormat(row.format, row.version);
  }

  async function insert(workspaceId: string, input: CreateFormatRequest, actor: PipelineActor) {
    return inTransaction(db, undefined, async (tx) => {
      await requireActiveWorkspace(tx, workspaceId);
      const slug =
        input.slug ??
        (await freeWorkspaceSlug(
          tx,
          "format",
          workspaceId,
          nameSlug(input.name, FALLBACK_FORMAT_SLUG),
        ));
      const formatId = randomUUID();
      const versionId = randomUUID();
      // The current-version foreign key is deferred, so the format goes in first.
      const [format] = await tx
        .insert(formats)
        .values({
          id: formatId,
          workspaceId,
          name: input.name,
          slug,
          currentVersionId: versionId,
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .returning();
      const [version] = await tx
        .insert(formatVersions)
        .values({
          id: versionId,
          formatId,
          versionNo: 1,
          rules: input.rules ?? structuredClone(DEFAULT_FORMAT_RULES),
          createdBy: actor.userId,
        })
        .returning();
      if (format === undefined || version === undefined) {
        throw new Error("format was not inserted");
      }
      await audit(tx, {
        ...auditActor(actor),
        action: "format.created",
        targetType: "format",
        targetId: formatId,
        data: { workspaceId, slug, versionId },
      });
      return toFormat(format, version);
    });
  }

  return {
    async create(workspaceId, input, actor) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await insert(workspaceId, input, actor);
        } catch (error) {
          if (!isUniqueViolation(error, SLUG_UNIQUE_CONSTRAINT)) {
            throw error;
          }
          if (input.slug !== undefined) {
            throw conflict("A format of this workspace already uses that slug.", { field: "slug" });
          }
          if (attempt >= SLUG_ATTEMPTS) {
            throw error;
          }
        }
      }
    },

    get,

    async list(workspaceId) {
      if (!(await workspaceExists(db, workspaceId))) {
        return null;
      }
      const rows = await selectFormats(db)
        .where(eq(formats.workspaceId, workspaceId))
        .orderBy(asc(formats.name), asc(formats.id));
      return rows.map((row) => toFormat(row.format, row.version));
    },

    async update(id, input, actor, options = {}) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      return inTransaction(db, options.tx, async (tx) => {
        // Locks the format, so concurrent updates queue up and each sees the one before it.
        const versionNo = await nextFormatVersionNo(tx, id);
        if (versionNo === null) {
          return null;
        }
        const [current] = await selectFormats(tx).where(eq(formats.id, id)).limit(1);
        if (current === undefined) {
          return null;
        }
        if (current.format.currentVersionId !== input.baseVersionId) {
          throw conflict("The format has a newer version. Reload it and try again.", {
            reason: "stale_version",
            currentVersionId: current.format.currentVersionId,
          });
        }
        const [version] = await tx
          .insert(formatVersions)
          .values({
            id: randomUUID(),
            formatId: id,
            versionNo,
            rules: input.rules ?? current.version.rules,
            createdBy: actor.userId,
          })
          .returning();
        if (version === undefined) {
          throw new Error("format version was not inserted");
        }
        const [format] = await tx
          .update(formats)
          .set({
            ...(input.name === undefined ? {} : { name: input.name }),
            currentVersionId: version.id,
            updatedAt: sql`now()`,
          })
          .where(eq(formats.id, id))
          .returning();
        if (format === undefined) {
          return null;
        }
        await audit(tx, {
          ...auditActor(actor),
          action: "format.updated",
          targetType: "format",
          targetId: id,
          data: {
            versionId: version.id,
            versionNo,
            fields: [
              ...(input.name === undefined ? [] : ["name"]),
              ...(input.rules === undefined ? [] : ["rules"]),
            ],
          },
        });
        const payload = {
          formatId: id,
          workspaceId: format.workspaceId,
          versionId: version.id,
          previousVersionId: current.version.id,
        };
        afterCommit(tx, () => bus.publish({ type: "format.updated", payload }));
        return toFormat(format, version);
      });
    },

    async versions(id) {
      const format = await get(id);
      if (format === null) {
        return null;
      }
      const rows = await db
        .select()
        .from(formatVersions)
        .where(eq(formatVersions.formatId, id))
        .orderBy(desc(formatVersions.versionNo));
      return rows.map(toFormatVersion);
    },

    async getVersion(versionId, executor = db) {
      if (!IdSchema.safeParse(versionId).success) {
        return null;
      }
      const [row] = await executor
        .select()
        .from(formatVersions)
        .where(eq(formatVersions.id, versionId))
        .limit(1);
      return row === undefined ? null : toFormatVersion(row);
    },

    async snapshotForSeries(seriesId, executor = db) {
      const row = await seriesFormat(executor, seriesId);
      return row === null ? null : { formatVersionId: row.version.id, rules: row.version.rules };
    },

    async rulesForSeries(seriesId, executor = db) {
      const row = await seriesFormat(executor, seriesId);
      return row === null
        ? null
        : {
            formatId: row.format.id,
            name: row.format.name,
            formatVersionId: row.version.id,
            version: row.version.versionNo,
            rules: row.version.rules,
          };
    },
  };
}

/** A format of the workspace, or null when it belongs elsewhere or does not exist. */
export async function formatOfWorkspace(
  executor: Executor,
  workspaceId: string,
  formatId: string,
): Promise<FormatRow | null> {
  const [row] = await executor
    .select()
    .from(formats)
    .where(and(eq(formats.id, formatId), eq(formats.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}
