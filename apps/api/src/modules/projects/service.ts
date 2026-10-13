import {
  type CreateProject,
  IdSchema,
  type Project,
  type ProjectStats,
  type ProjectStatus,
  SLUG_MAX_LENGTH,
  SlugSchema,
  slugify,
  type UpdateProject,
} from "@loomcast/contracts";
import { conversations, type Database, kbEntries, type ProjectRow, projects } from "@loomcast/db";
import { and, count, desc, eq, isNull, like, type SQL, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, isUniqueViolation, transaction } from "../../lib/db";
import { conflict } from "../../lib/errors";

/** Slug used when the name leaves nothing usable, for example a name without Latin letters. */
export const FALLBACK_SLUG = "project";

/** Longest collision suffix the lookup covers in one query (`-99999`). */
const MAX_SUFFIX_LENGTH = 6;

/** Attempts at a derived slug before giving up, when parallel creates keep taking the same one. */
const SLUG_ATTEMPTS = 5;

const SLUG_UNIQUE_CONSTRAINT = "projects_slug_uq";

/**
 * Who changes a project. A web user acts as themselves; an MCP token acts for its user, so
 * `userId` becomes `created_by` while the audit row names the token.
 */
export interface ProjectActor {
  kind: "user" | "token";
  /** The user id, or the token id for `token`. */
  id: string;
  /** The account the change belongs to. */
  userId: string;
  ip?: string | null;
}

export interface ListProjectsOptions {
  status?: ProjectStatus;
}

export interface ProjectsService {
  /**
   * Creates a project and publishes `project.created` once committed. Without `slug` the slug is
   * derived from the name, with `-2`, `-3`, … added on collision. An explicit slug that is taken
   * is a 409.
   */
  create(input: CreateProject, actor: ProjectActor): Promise<Project>;
  /** A project by id or slug, or null. */
  get(idOrSlug: string, executor?: Executor): Promise<Project | null>;
  /** Projects, most recently updated first. */
  list(options?: ListProjectsOptions): Promise<Project[]>;
  /** Renames or re-describes a project and publishes `project.updated`. Null when not found. */
  update(idOrSlug: string, input: UpdateProject, actor: ProjectActor): Promise<Project | null>;
  /**
   * Archives a project and publishes `project.updated`. Archiving an archived project returns it
   * unchanged. Null when not found.
   */
  archive(id: string, actor: ProjectActor): Promise<Project | null>;
  /** Counts of what a project holds, for the MCP `project.get` tool. */
  stats(projectId: string): Promise<ProjectStats>;
}

export interface ProjectsServiceDeps {
  db: Database;
  bus: EventBus;
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/** The slug a name turns into before collisions are considered. */
export function baseSlug(name: string): string {
  const slug = slugify(name);
  return slug !== "" && SlugSchema.safeParse(slug).success ? slug : FALLBACK_SLUG;
}

/** `base` with `-n` appended, shortened so the result stays within `SLUG_MAX_LENGTH`. */
export function slugWithSuffix(base: string, n: number): string {
  const suffix = `-${n}`;
  const stem = base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, "");
  return `${stem}${suffix}`;
}

/**
 * The first of `base`, `base-2`, `base-3`, … that no project uses yet. Must run inside the
 * transaction that inserts the project: it holds a transaction-level advisory lock on the slug
 * prefix, so parallel creates of the same name queue up instead of racing for one candidate.
 */
async function freeSlug(executor: Executor, base: string): Promise<string> {
  // Every candidate starts with this prefix, so one query finds all the slugs in the way. Slugs
  // hold only `[a-z0-9-]`, so the prefix needs no LIKE escaping.
  const prefix = base.slice(0, SLUG_MAX_LENGTH - MAX_SUFFIX_LENGTH).replace(/-+$/, "");
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`loomcast:project-slug:${prefix}`}))`,
  );
  const rows = await executor
    .select({ slug: projects.slug })
    .from(projects)
    .where(like(projects.slug, `${prefix}%`));
  const taken = new Set(rows.map((row) => row.slug));
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = slugWithSuffix(base, n);
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

function idOrSlugCondition(idOrSlug: string): SQL | undefined {
  return IdSchema.safeParse(idOrSlug).success
    ? eq(projects.id, idOrSlug)
    : SlugSchema.safeParse(idOrSlug).success
      ? eq(projects.slug, idOrSlug)
      : undefined;
}

/** Empty or blank descriptions are stored as null. */
function normaliseDescription(description: string | null | undefined): string | null | undefined {
  return description === "" ? null : description;
}

function auditActor(actor: ProjectActor) {
  return { actorKind: actor.kind, actorId: actor.id, ip: actor.ip ?? null } as const;
}

export function createProjectsService(deps: ProjectsServiceDeps): ProjectsService {
  const { db, bus } = deps;

  async function find(executor: Executor, idOrSlug: string, forUpdate = false) {
    const condition = idOrSlugCondition(idOrSlug);
    if (condition === undefined) {
      return null;
    }
    const query = executor.select().from(projects).where(condition).limit(1);
    const [row] = forUpdate ? await query.for("update") : await query;
    return row ?? null;
  }

  async function insert(input: CreateProject, actor: ProjectActor) {
    return transaction(db, async (tx) => {
      const chosen = input.slug ?? (await freeSlug(tx, baseSlug(input.name)));
      const [row] = await tx
        .insert(projects)
        .values({
          slug: chosen,
          name: input.name,
          description: normaliseDescription(input.description) ?? null,
          createdBy: actor.userId,
        })
        .returning();
      if (row === undefined) {
        throw new Error("project was not inserted");
      }
      await audit(tx, {
        ...auditActor(actor),
        action: "project.created",
        targetType: "project",
        targetId: row.id,
        data: { slug: row.slug, name: row.name },
      });
      const project = toProject(row);
      afterCommit(tx, () => bus.publish({ type: "project.created", payload: { project } }));
      return project;
    });
  }

  return {
    async create(input, actor) {
      if (input.slug !== undefined) {
        try {
          return await insert(input, actor);
        } catch (error) {
          if (isUniqueViolation(error, SLUG_UNIQUE_CONSTRAINT)) {
            throw conflict("A project already uses that slug.", { field: "slug" });
          }
          throw error;
        }
      }
      // Creates of the same name are serialised by the slug lock; the retry only covers an
      // explicit slug taken between this lookup and the insert by a create of another name.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await insert(input, actor);
        } catch (error) {
          if (!isUniqueViolation(error, SLUG_UNIQUE_CONSTRAINT) || attempt >= SLUG_ATTEMPTS) {
            throw error;
          }
        }
      }
    },

    async get(idOrSlug, executor = db) {
      const row = await find(executor, idOrSlug);
      return row === null ? null : toProject(row);
    },

    async list(options = {}) {
      const rows = await db
        .select()
        .from(projects)
        .where(options.status === undefined ? undefined : eq(projects.status, options.status))
        .orderBy(desc(projects.updatedAt), desc(projects.id));
      return rows.map(toProject);
    },

    async update(idOrSlug, input, actor) {
      return transaction(db, async (tx) => {
        const existing = await find(tx, idOrSlug, true);
        if (existing === null) {
          return null;
        }
        const description = normaliseDescription(input.description);
        // Timestamps come from the database, like `created_at`, so they always order consistently.
        const [row] = await tx
          .update(projects)
          .set({
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(description === undefined ? {} : { description }),
            updatedAt: sql`now()`,
          })
          .where(eq(projects.id, existing.id))
          .returning();
        if (row === undefined) {
          return null;
        }
        await audit(tx, {
          ...auditActor(actor),
          action: "project.updated",
          targetType: "project",
          targetId: row.id,
          data: {
            fields: [
              ...(input.name === undefined ? [] : ["name"]),
              ...(description === undefined ? [] : ["description"]),
            ],
          },
        });
        const project = toProject(row);
        afterCommit(tx, () => bus.publish({ type: "project.updated", payload: { project } }));
        return project;
      });
    },

    async archive(id, actor) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      return transaction(db, async (tx) => {
        const existing = await find(tx, id, true);
        if (existing === null) {
          return null;
        }
        if (existing.status === "archived") {
          return toProject(existing);
        }
        const [row] = await tx
          .update(projects)
          .set({ status: "archived", archivedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(projects.id, existing.id))
          .returning();
        if (row === undefined) {
          return null;
        }
        await audit(tx, {
          ...auditActor(actor),
          action: "project.archived",
          targetType: "project",
          targetId: row.id,
          data: { slug: row.slug },
        });
        const project = toProject(row);
        afterCommit(tx, () => bus.publish({ type: "project.updated", payload: { project } }));
        return project;
      });
    },

    async stats(projectId) {
      const [[conversationCount], [kbCount]] = await Promise.all([
        db
          .select({ count: count() })
          .from(conversations)
          .where(eq(conversations.projectId, projectId)),
        // Deleted entries are kept for the audit trail but no longer count.
        db
          .select({ count: count() })
          .from(kbEntries)
          .where(and(eq(kbEntries.projectId, projectId), isNull(kbEntries.deletedAt))),
      ]);
      return {
        conversations: conversationCount?.count ?? 0,
        kbEntries: kbCount?.count ?? 0,
        items: 0,
      };
    },
  };
}
