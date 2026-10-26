import {
  type CreateWorkspace,
  IdSchema,
  SLUG_MAX_LENGTH,
  SlugSchema,
  slugify,
  type UpdateWorkspace,
  type Workspace,
  type WorkspaceIconMime,
  type WorkspaceStats,
  type WorkspaceStatus,
} from "@loomcast/contracts";
import {
  contentItems,
  conversations,
  type Database,
  kbEntries,
  type WorkspaceRow,
  workspaces,
} from "@loomcast/db";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  isNull,
  like,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, isUniqueViolation, transaction } from "../../lib/db";
import { conflict } from "../../lib/errors";

/** Slug used when the name leaves nothing usable, for example a name without Latin letters. */
export const FALLBACK_SLUG = "workspace";

/** Longest collision suffix the lookup covers in one query (`-99999`). */
const MAX_SUFFIX_LENGTH = 6;

/** Attempts at a derived slug before giving up, when parallel creates keep taking the same one. */
const SLUG_ATTEMPTS = 5;

const SLUG_UNIQUE_CONSTRAINT = "workspaces_slug_uq";

/**
 * Who changes a workspace. A web user acts as themselves; an MCP token acts for its user, so
 * `userId` becomes `created_by` while the audit row names the token.
 */
export interface WorkspaceActor {
  kind: "user" | "token";
  /** The user id, or the token id for `token`. */
  id: string;
  /** The account the change belongs to. */
  userId: string;
  ip?: string | null;
}

/** A workspace's icon image. */
export interface WorkspaceIcon {
  body: Uint8Array;
  mime: WorkspaceIconMime;
}

/** Every column but the icon's bytes, which only the icon route reads. */
const { icon: _icon, ...workspaceColumns } = getTableColumns(workspaces);

/** A workspace row without its icon's bytes. */
export type WorkspaceView = Omit<WorkspaceRow, "icon">;

export interface ListWorkspacesOptions {
  status?: WorkspaceStatus;
}

export interface WorkspacesService {
  /**
   * Creates a workspace and publishes `workspace.created` once committed. Without `slug` the slug is
   * derived from the name, with `-2`, `-3`, … added on collision. An explicit slug that is taken
   * is a 409.
   */
  create(input: CreateWorkspace, actor: WorkspaceActor): Promise<Workspace>;
  /** A workspace by id or slug, or null. */
  get(idOrSlug: string, executor?: Executor): Promise<Workspace | null>;
  /** Workspaces, most recently updated first. */
  list(options?: ListWorkspacesOptions): Promise<Workspace[]>;
  /** Renames or re-describes a workspace and publishes `workspace.updated`. Null when not found. */
  update(
    idOrSlug: string,
    input: UpdateWorkspace,
    actor: WorkspaceActor,
  ): Promise<Workspace | null>;
  /**
   * Archives a workspace and publishes `workspace.updated`. Archiving an archived workspace returns it
   * unchanged. Null when not found.
   */
  archive(id: string, actor: WorkspaceActor): Promise<Workspace | null>;
  /** Counts of what a workspace holds, for the MCP `workspace.get` tool. */
  stats(workspaceId: string): Promise<WorkspaceStats>;
  /** The workspace's icon, or null when it has none or does not exist. */
  icon(id: string): Promise<WorkspaceIcon | null>;
  /**
   * Replaces the icon (null clears it) and publishes `workspace.updated`. The caller has checked
   * the image's type and size. Null when the workspace does not exist.
   */
  setIcon(id: string, icon: WorkspaceIcon | null, actor: WorkspaceActor): Promise<Workspace | null>;
}

export interface WorkspacesServiceDeps {
  db: Database;
  bus: EventBus;
}

/** Path the web app loads a workspace's icon from; the version changes with the image. */
export function workspaceIconPath(id: string, updatedAt: Date): string {
  return `/api/workspaces/${id}/icon?v=${updatedAt.getTime()}`;
}

export function toWorkspace(row: WorkspaceView): Workspace {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    color: row.color,
    iconUrl: row.iconUpdatedAt === null ? null : workspaceIconPath(row.id, row.iconUpdatedAt),
    timeZone: row.timeZone,
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
 * The first of `base`, `base-2`, `base-3`, … that no workspace uses yet. Must run inside the
 * transaction that inserts the workspace: it holds a transaction-level advisory lock on the slug
 * prefix, so parallel creates of the same name queue up instead of racing for one candidate.
 */
async function freeSlug(executor: Executor, base: string): Promise<string> {
  // Every candidate starts with this prefix, so one query finds all the slugs in the way. Slugs
  // hold only `[a-z0-9-]`, so the prefix needs no LIKE escaping.
  const prefix = base.slice(0, SLUG_MAX_LENGTH - MAX_SUFFIX_LENGTH).replace(/-+$/, "");
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`loomcast:workspace-slug:${prefix}`}))`,
  );
  const rows = await executor
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(like(workspaces.slug, `${prefix}%`));
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
    ? eq(workspaces.id, idOrSlug)
    : SlugSchema.safeParse(idOrSlug).success
      ? eq(workspaces.slug, idOrSlug)
      : undefined;
}

/** Empty or blank descriptions are stored as null. */
function normaliseDescription(description: string | null | undefined): string | null | undefined {
  return description === "" ? null : description;
}

function auditActor(actor: WorkspaceActor) {
  return { actorKind: actor.kind, actorId: actor.id, ip: actor.ip ?? null } as const;
}

export function createWorkspacesService(deps: WorkspacesServiceDeps): WorkspacesService {
  const { db, bus } = deps;

  async function find(executor: Executor, idOrSlug: string, forUpdate = false) {
    const condition = idOrSlugCondition(idOrSlug);
    if (condition === undefined) {
      return null;
    }
    const query = executor.select(workspaceColumns).from(workspaces).where(condition).limit(1);
    const [row] = forUpdate ? await query.for("update") : await query;
    return row ?? null;
  }

  async function insert(input: CreateWorkspace, actor: WorkspaceActor) {
    return transaction(db, async (tx) => {
      const chosen = input.slug ?? (await freeSlug(tx, baseSlug(input.name)));
      const [row] = await tx
        .insert(workspaces)
        .values({
          slug: chosen,
          name: input.name,
          description: normaliseDescription(input.description) ?? null,
          ...(input.color === undefined ? {} : { color: input.color }),
          ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
          createdBy: actor.userId,
        })
        .returning(workspaceColumns);
      if (row === undefined) {
        throw new Error("workspace was not inserted");
      }
      await audit(tx, {
        ...auditActor(actor),
        action: "workspace.created",
        targetType: "workspace",
        targetId: row.id,
        data: { slug: row.slug, name: row.name },
      });
      const workspace = toWorkspace(row);
      afterCommit(tx, () => bus.publish({ type: "workspace.created", payload: { workspace } }));
      return workspace;
    });
  }

  return {
    async create(input, actor) {
      if (input.slug !== undefined) {
        try {
          return await insert(input, actor);
        } catch (error) {
          if (isUniqueViolation(error, SLUG_UNIQUE_CONSTRAINT)) {
            throw conflict("A workspace already uses that slug.", { field: "slug" });
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
      return row === null ? null : toWorkspace(row);
    },

    async list(options = {}) {
      const rows = await db
        .select(workspaceColumns)
        .from(workspaces)
        .where(options.status === undefined ? undefined : eq(workspaces.status, options.status))
        .orderBy(desc(workspaces.updatedAt), desc(workspaces.id));
      return rows.map(toWorkspace);
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
          .update(workspaces)
          .set({
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(description === undefined ? {} : { description }),
            ...(input.color === undefined ? {} : { color: input.color }),
            ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
            updatedAt: sql`now()`,
          })
          .where(eq(workspaces.id, existing.id))
          .returning(workspaceColumns);
        if (row === undefined) {
          return null;
        }
        await audit(tx, {
          ...auditActor(actor),
          action: "workspace.updated",
          targetType: "workspace",
          targetId: row.id,
          data: {
            fields: [
              ...(input.name === undefined ? [] : ["name"]),
              ...(description === undefined ? [] : ["description"]),
              ...(input.color === undefined ? [] : ["color"]),
              ...(input.timeZone === undefined ? [] : ["timeZone"]),
            ],
          },
        });
        const workspace = toWorkspace(row);
        afterCommit(tx, () => bus.publish({ type: "workspace.updated", payload: { workspace } }));
        return workspace;
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
          return toWorkspace(existing);
        }
        const [row] = await tx
          .update(workspaces)
          .set({ status: "archived", archivedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(workspaces.id, existing.id))
          .returning(workspaceColumns);
        if (row === undefined) {
          return null;
        }
        await audit(tx, {
          ...auditActor(actor),
          action: "workspace.archived",
          targetType: "workspace",
          targetId: row.id,
          data: { slug: row.slug },
        });
        const workspace = toWorkspace(row);
        afterCommit(tx, () => bus.publish({ type: "workspace.updated", payload: { workspace } }));
        return workspace;
      });
    },

    async icon(id) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      const [row] = await db
        .select({ icon: workspaces.icon, mime: workspaces.iconMime })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1);
      if (row?.icon === null || row?.icon === undefined || row.mime === null) {
        return null;
      }
      return { body: row.icon, mime: row.mime as WorkspaceIconMime };
    },

    async setIcon(id, icon, actor) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      return transaction(db, async (tx) => {
        const existing = await find(tx, id, true);
        if (existing === null) {
          return null;
        }
        const [row] = await tx
          .update(workspaces)
          .set(
            icon === null
              ? { icon: null, iconMime: null, iconUpdatedAt: null, updatedAt: sql`now()` }
              : {
                  icon: Buffer.from(icon.body),
                  iconMime: icon.mime,
                  iconUpdatedAt: sql`now()`,
                  updatedAt: sql`now()`,
                },
          )
          .where(eq(workspaces.id, existing.id))
          .returning(workspaceColumns);
        if (row === undefined) {
          return null;
        }
        await audit(tx, {
          ...auditActor(actor),
          action: icon === null ? "workspace.icon_cleared" : "workspace.icon_set",
          targetType: "workspace",
          targetId: row.id,
          data: icon === null ? {} : { mime: icon.mime, bytes: icon.body.byteLength },
        });
        const workspace = toWorkspace(row);
        afterCommit(tx, () => bus.publish({ type: "workspace.updated", payload: { workspace } }));
        return workspace;
      });
    },

    async stats(workspaceId) {
      const [[conversationCount], [kbCount], [itemCount]] = await Promise.all([
        db
          .select({ count: count() })
          .from(conversations)
          .where(eq(conversations.workspaceId, workspaceId)),
        // Deleted entries are kept for the audit trail but no longer count.
        db
          .select({ count: count() })
          .from(kbEntries)
          .where(and(eq(kbEntries.workspaceId, workspaceId), isNull(kbEntries.deletedAt))),
        // Archived items have left the pipeline and no longer count.
        db
          .select({ count: count() })
          .from(contentItems)
          .where(
            and(eq(contentItems.workspaceId, workspaceId), ne(contentItems.state, "archived")),
          ),
      ]);
      return {
        conversations: conversationCount?.count ?? 0,
        kbEntries: kbCount?.count ?? 0,
        items: itemCount?.count ?? 0,
      };
    },
  };
}
