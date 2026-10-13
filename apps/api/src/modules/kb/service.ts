import {
  type CaptureConversation,
  type CursorPage,
  DEFAULT_PAGE_LIMIT,
  type DecisionData,
  IdSchema,
  type JsonObject,
  KB_TITLE_MAX_LENGTH,
  type KbCreatedVia,
  type KbEntry,
  type KbEntryDetail,
  type KbEntryKind,
  type KbTagCount,
  type ListKbQuery,
  MAX_KB_BODY_LENGTH,
  normalizeReferenceUrl,
  parseKbEntryData,
  type ReferenceAnalysis,
  type ReferencePlatform,
  type UpdateKbEntry,
} from "@loomcast/contracts";
import {
  conversations,
  type Database,
  type KbReferenceRow,
  kbEntries,
  kbReferences,
  messages,
  type NewKbEntryRow,
  projects,
} from "@loomcast/db";
import { and, arrayContains, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, type Transaction, transaction } from "../../lib/db";
import { conflict, notFound, validationFailed } from "../../lib/errors";
import { type EntryRow, entryColumns, toKbEntry, toKbEntryDetail } from "./mappers";
import {
  defaultReferenceTitle,
  optionalText,
  referenceDedupeKey,
  referenceSearchText,
} from "./references";
import { normalizeTags } from "./tags";

/**
 * Who writes to the knowledge base. A web user acts as themselves; an MCP or job token acts for
 * its user, so `userId` becomes `created_by` and the token is kept in `created_by_token_id`.
 */
export interface KbActor {
  kind: "user" | "token";
  /** The user id, or the token id for `token`. */
  id: string;
  /** The account the write belongs to. */
  userId: string;
  /** Stored as the entry's `created_via` on creates. */
  via: KbCreatedVia;
  ip?: string | null;
}

interface CommonEntryFields {
  title: string;
  tags?: readonly string[];
  /** The conversation the entry was captured from or written in. */
  conversationId?: string | null;
}

export interface NewTextEntry extends CommonEntryFields {
  kind: "brainstorm" | "note";
  bodyMd: string;
  /** Producer session or client conversation the text came from. */
  sessionRef?: string;
}

export interface NewDecisionEntry extends CommonEntryFields {
  kind: "decision";
  decision: string;
  rationale?: string;
  /** A decision of the same project that this one replaces. */
  supersedes?: string;
}

/**
 * A reference link. The URL is normalised (`normalizeReferenceUrl`) and never fetched: nothing
 * about the video is downloaded, previewed or embedded.
 */
export interface NewReferenceEntry extends Omit<CommonEntryFields, "title"> {
  kind: "reference";
  /** As typed by the user. */
  url: string;
  /** Detected from the URL when omitted. */
  platform?: ReferencePlatform;
  /** Defaults to a title built from the platform and author. */
  title?: string;
  author?: string;
  likedReason?: string;
  /** Untrusted text supplied by the user. */
  transcript?: string;
  /** An analysis made elsewhere, for example by a producer session through MCP. */
  analysis?: ReferenceAnalysis;
}

/** What `create` accepts: the web app's `CreateKbEntry` and the MCP tools' inputs fit it. */
export type NewKbEntry = NewTextEntry | NewDecisionEntry | NewReferenceEntry;

export interface SessionSummaryInput {
  sessionId: string;
  summaryMd: string;
  cwd?: string;
  /** Defaults to a title built from the first line of the summary. */
  title?: string;
  tags?: readonly string[];
}

export interface SessionSummaryResult {
  entry: KbEntryDetail;
  /** False when the session already had a summary, which was replaced. */
  created: boolean;
}

export interface KbService {
  /**
   * Creates an entry and publishes `kb.entry.created` once committed. 404 for an unknown project,
   * 409 for an archived one. A decision with `supersedes` marks that decision `superseded` and
   * links both, in the same transaction.
   */
  create(projectId: string, input: NewKbEntry, actor: KbActor): Promise<KbEntryDetail>;
  /**
   * Writes the summary of a working session, keyed by `session:<sessionId>`: a second call for the
   * same session replaces the summary instead of adding an entry.
   */
  saveSessionSummary(
    projectId: string,
    input: SessionSummaryInput,
    actor: KbActor,
  ): Promise<SessionSummaryResult>;
  /**
   * Copies messages of a conversation into a new brainstorm or note, as `**You:**` and
   * `**Producer:**` blocks in the order they were posted.
   */
  capture(projectId: string, input: CaptureConversation, actor: KbActor): Promise<KbEntryDetail>;
  /** An entry that is not deleted, or null. */
  get(id: string, executor?: Executor): Promise<KbEntryDetail | null>;
  /** Entries of a project, most recently updated first. Null when the project is unknown. */
  list(projectId: string, query?: ListKbQuery): Promise<CursorPage<KbEntry> | null>;
  /** Tags in use in a project with their entry counts, most used first. Null for no project. */
  tags(projectId: string): Promise<KbTagCount[] | null>;
  /**
   * Applies a partial update and publishes `kb.entry.updated`. 409 when `expectedUpdatedAt` is
   * not the entry's current `updatedAt`; 400 for fields that do not apply to the entry's kind.
   * Null when there is no such entry.
   */
  update(id: string, input: UpdateKbEntry, actor: KbActor): Promise<KbEntryDetail | null>;
  /** Soft-deletes an entry and publishes `kb.entry.deleted`. False when there is no such entry. */
  softDelete(id: string, actor: KbActor): Promise<boolean>;
}

export interface KbServiceDeps {
  db: Database;
  bus: EventBus;
}

/** The fields `update` accepts for every kind, and the extra ones per kind. */
const COMMON_UPDATE_FIELDS = ["title", "bodyMd", "tags"] as const;
const KIND_UPDATE_FIELDS: { readonly [K in KbEntryKind]: readonly string[] } = {
  brainstorm: [],
  note: [],
  session_summary: [],
  decision: ["decision", "rationale", "status"],
  reference: ["likedReason", "author", "transcript"],
};

const SPEAKER_LABELS: Readonly<Record<string, string>> = {
  user: "**You:**",
  assistant: "**Producer:**",
};

const CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** `updated_at` as fixed-format UTC text with microseconds, for an exact keyset cursor. */
const cursorTimestamp = sql<string>`to_char(${kbEntries.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** `updated_at` of a new row, in whole milliseconds so it survives a round trip through JSON. */
const insertedAt = sql<Date>`date_trunc('milliseconds', now())`;

/**
 * `updated_at` of a changed row: now, and at least a millisecond after the previous value, so two
 * writes in the same millisecond never share an `updatedAt` and a stale editor always gets a 409.
 */
export const bumpedUpdatedAt = sql<Date>`greatest(date_trunc('milliseconds', now()), ${kbEntries.updatedAt} + interval '1 millisecond')`;

export const archivedProject = () =>
  conflict("The project is archived. Restore it before adding to it.", { reason: "archived" });

export const projectNotFound = () => notFound("Project not found.");

export function encodeKbCursor(timestamp: string, id: string): string {
  return Buffer.from(`${timestamp}_${id}`, "utf8").toString("base64url");
}

function decodeKbCursor(cursor: string): { timestamp: string; id: string } {
  const match = CURSOR_RE.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw validationFailed([{ path: "cursor", message: "Unknown cursor" }]);
  }
  return { timestamp: match[1], id: match[2] };
}

/** A title from the first non-empty line of markdown, without heading marks. */
export function titleFromMarkdown(markdown: string, prefix: string): string {
  const firstLine =
    markdown
      .split("\n")
      .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
      .find((line) => line.length > 0) ?? "";
  const title = firstLine === "" ? prefix.replace(/:\s*$/, "") : `${prefix} ${firstLine}`;
  return title.length > KB_TITLE_MAX_LENGTH
    ? `${title.slice(0, KB_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : title;
}

export function auditActor(actor: KbActor) {
  return { actorKind: actor.kind, actorId: actor.id, ip: actor.ip ?? null } as const;
}

/** Columns that record who wrote an entry. */
export function authorship(actor: KbActor) {
  return {
    createdBy: actor.userId,
    createdByTokenId: actor.kind === "token" ? actor.id : null,
    createdVia: actor.via,
  } as const;
}

/**
 * Throws unless the project exists and is active. Takes a share lock, so the project cannot be
 * archived while the entry is written.
 */
export async function requireActiveProject(tx: Transaction, projectId: string): Promise<void> {
  if (!IdSchema.safeParse(projectId).success) {
    throw projectNotFound();
  }
  const [project] = await tx
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .for("share");
  if (project === undefined) {
    throw projectNotFound();
  }
  if (project.status === "archived") {
    throw archivedProject();
  }
}

async function projectExists(executor: Executor, projectId: string): Promise<boolean> {
  if (!IdSchema.safeParse(projectId).success) {
    return false;
  }
  const [row] = await executor
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row !== undefined;
}

/** A conversation id of this project, or a 404. */
async function requireConversation(
  executor: Executor,
  projectId: string,
  conversationId: string,
): Promise<void> {
  const [row] = await executor
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.projectId, projectId)))
    .limit(1);
  if (row === undefined) {
    throw notFound("No conversation with that id in this project.");
  }
}

export async function loadReference(
  executor: Executor,
  entryId: string,
): Promise<KbReferenceRow | null> {
  const [row] = await executor
    .select()
    .from(kbReferences)
    .where(eq(kbReferences.entryId, entryId))
    .limit(1);
  return row ?? null;
}

/** A live entry locked for update, or null. */
export async function lockEntry(tx: Transaction, id: string): Promise<EntryRow | null> {
  if (!IdSchema.safeParse(id).success) {
    return null;
  }
  const [row] = await tx
    .select(entryColumns)
    .from(kbEntries)
    .where(and(eq(kbEntries.id, id), isNull(kbEntries.deletedAt)))
    .limit(1)
    .for("update");
  return row ?? null;
}

export function createKbService(deps: KbServiceDeps): KbService {
  const { db, bus } = deps;

  function publishCreated(tx: Transaction, row: EntryRow): void {
    const entry = toKbEntry(row);
    afterCommit(tx, () => bus.publish({ type: "kb.entry.created", payload: { entry } }));
  }

  function publishUpdated(tx: Transaction, row: EntryRow): void {
    const entry = toKbEntry(row);
    afterCommit(tx, () => bus.publish({ type: "kb.entry.updated", payload: { entry } }));
  }

  /** Inserts an entry with its audit row and `kb.entry.created`. */
  async function insertEntry(
    tx: Transaction,
    values: Omit<NewKbEntryRow, "createdBy" | "createdByTokenId" | "createdVia">,
    actor: KbActor,
  ): Promise<EntryRow> {
    const row = await tryInsertEntry(tx, values, actor);
    if (row === null) {
      throw new Error("knowledge base entry was not inserted");
    }
    return row;
  }

  /**
   * Like `insertEntry`, but a `dedupeKey` already used by a live entry of the project inserts
   * nothing and returns null.
   */
  async function tryInsertEntry(
    tx: Transaction,
    values: Omit<NewKbEntryRow, "createdBy" | "createdByTokenId" | "createdVia">,
    actor: KbActor,
  ): Promise<EntryRow | null> {
    const [row] = await tx
      .insert(kbEntries)
      .values({ ...values, ...authorship(actor), updatedAt: insertedAt })
      .onConflictDoNothing({
        target: [kbEntries.projectId, kbEntries.dedupeKey],
        where: sql`dedupe_key is not null and deleted_at is null`,
      })
      .returning(entryColumns);
    if (row === undefined) {
      return null;
    }
    await audit(tx, {
      ...auditActor(actor),
      action: "kb.entry.create",
      targetType: "kb_entry",
      targetId: row.id,
      data: { projectId: row.projectId, kind: row.kind, via: row.createdVia },
    });
    publishCreated(tx, row);
    return row;
  }

  /** Marks `oldId` superseded by `newId`. The old decision must be active, in the same project. */
  async function supersede(tx: Transaction, projectId: string, oldId: string): Promise<EntryRow> {
    const old = await lockEntry(tx, oldId);
    if (old === null || old.projectId !== projectId || old.kind !== "decision") {
      throw validationFailed([
        { path: "supersedes", message: "No decision with that id in this project" },
      ]);
    }
    if (old.data.status === "superseded") {
      throw conflict("That decision has already been superseded.", {
        reason: "superseded",
        entryId: old.id,
        supersededBy: old.data.supersededBy ?? null,
      });
    }
    return old;
  }

  async function markSuperseded(
    tx: Transaction,
    old: EntryRow,
    newId: string,
    actor: KbActor,
  ): Promise<void> {
    const [row] = await tx
      .update(kbEntries)
      .set({
        data: { ...old.data, status: "superseded", supersededBy: newId },
        updatedAt: bumpedUpdatedAt,
      })
      .where(eq(kbEntries.id, old.id))
      .returning(entryColumns);
    if (row === undefined) {
      throw new Error("superseded decision vanished inside its transaction");
    }
    await audit(tx, {
      ...auditActor(actor),
      action: "kb.entry.update",
      targetType: "kb_entry",
      targetId: row.id,
      data: { projectId: row.projectId, fields: ["status"], supersededBy: newId },
    });
    publishUpdated(tx, row);
  }

  async function createText(
    tx: Transaction,
    projectId: string,
    input: NewTextEntry,
    actor: KbActor,
  ): Promise<KbEntryDetail> {
    const data: JsonObject = input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef };
    const row = await insertEntry(
      tx,
      {
        projectId,
        kind: input.kind,
        title: input.title,
        bodyMd: input.bodyMd,
        tags: normalizeTags(input.tags ?? []),
        data,
        conversationId: input.conversationId ?? null,
      },
      actor,
    );
    return toKbEntryDetail(row, null);
  }

  async function createDecision(
    tx: Transaction,
    projectId: string,
    input: NewDecisionEntry,
    actor: KbActor,
  ): Promise<KbEntryDetail> {
    const old =
      input.supersedes === undefined ? null : await supersede(tx, projectId, input.supersedes);
    const data: DecisionData & { supersedes?: string } = {
      decision: input.decision,
      ...(input.rationale === undefined || input.rationale === ""
        ? {}
        : { rationale: input.rationale }),
      status: "active",
      ...(old === null ? {} : { supersedes: old.id }),
    };
    const row = await insertEntry(
      tx,
      {
        projectId,
        kind: "decision",
        title: input.title,
        bodyMd: "",
        tags: normalizeTags(input.tags ?? []),
        data,
        conversationId: input.conversationId ?? null,
      },
      actor,
    );
    if (old !== null) {
      await markSuperseded(tx, old, row.id, actor);
    }
    return toKbEntryDetail(row, null);
  }

  async function createReference(
    tx: Transaction,
    projectId: string,
    input: NewReferenceEntry,
    actor: KbActor,
  ): Promise<KbEntryDetail> {
    let normalized: ReturnType<typeof normalizeReferenceUrl>;
    try {
      normalized = normalizeReferenceUrl(input.url);
    } catch {
      throw validationFailed([{ path: "url", message: "Enter an http or https link" }]);
    }
    const platform = input.platform ?? normalized.platform;
    const author = optionalText(input.author);
    const likedReason = optionalText(input.likedReason);
    const transcript = optionalText(input.transcript);
    const analysis = input.analysis ?? null;
    const dedupeKey = referenceDedupeKey(normalized.url);

    const row = await tryInsertEntry(
      tx,
      {
        projectId,
        kind: "reference",
        title: optionalText(input.title) ?? defaultReferenceTitle(platform, author),
        bodyMd: "",
        tags: normalizeTags(input.tags ?? []),
        data: {},
        sourceUrl: normalized.url,
        conversationId: input.conversationId ?? null,
        dedupeKey,
        searchExtra: referenceSearchText({ author, likedReason, transcript, analysis }),
      },
      actor,
    );
    if (row === null) {
      const [existing] = await tx
        .select({ id: kbEntries.id })
        .from(kbEntries)
        .where(
          and(
            eq(kbEntries.projectId, projectId),
            eq(kbEntries.dedupeKey, dedupeKey),
            isNull(kbEntries.deletedAt),
          ),
        )
        .limit(1);
      throw conflict("This reference is already saved in the project.", {
        reason: "duplicate",
        entryId: existing?.id ?? null,
      });
    }
    const [reference] = await tx
      .insert(kbReferences)
      .values({
        entryId: row.id,
        url: normalized.url,
        platform,
        author,
        likedReason,
        transcript,
        analysis,
        analysisStatus: analysis === null ? "none" : "done",
        analyzedAt: analysis === null ? null : sql`now()`,
      })
      .returning();
    if (reference === undefined) {
      throw new Error("reference was not inserted");
    }
    return toKbEntryDetail(row, reference);
  }

  async function get(id: string, executor: Executor = db): Promise<KbEntryDetail | null> {
    if (!IdSchema.safeParse(id).success) {
      return null;
    }
    // One statement, so the entry and its reference come from the same snapshot even while an
    // analysis result is being written.
    const [row] = await executor
      .select({ entry: entryColumns, reference: kbReferences })
      .from(kbEntries)
      .leftJoin(kbReferences, eq(kbReferences.entryId, kbEntries.id))
      .where(and(eq(kbEntries.id, id), isNull(kbEntries.deletedAt)))
      .limit(1);
    return row === undefined ? null : toKbEntryDetail(row.entry, row.reference);
  }

  return {
    create(projectId, input, actor) {
      return transaction(db, async (tx) => {
        await requireActiveProject(tx, projectId);
        if (input.conversationId != null) {
          await requireConversation(tx, projectId, input.conversationId);
        }
        switch (input.kind) {
          case "brainstorm":
          case "note":
            return createText(tx, projectId, input, actor);
          case "decision":
            return createDecision(tx, projectId, input, actor);
          case "reference":
            return createReference(tx, projectId, input, actor);
        }
      });
    },

    saveSessionSummary(projectId, input, actor) {
      return transaction(db, async (tx) => {
        await requireActiveProject(tx, projectId);
        const dedupeKey = `session:${input.sessionId}`;
        // Serialises writers of the same session, so two calls never race to insert.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`loomcast:kb:${projectId}:${dedupeKey}`}))`,
        );
        const title = input.title ?? titleFromMarkdown(input.summaryMd, "Session summary:");
        const data: JsonObject = {
          sessionId: input.sessionId,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        };
        const tags = normalizeTags(input.tags ?? []);
        const [existing] = await tx
          .select(entryColumns)
          .from(kbEntries)
          .where(
            and(
              eq(kbEntries.projectId, projectId),
              eq(kbEntries.dedupeKey, dedupeKey),
              isNull(kbEntries.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (existing === undefined) {
          const row = await insertEntry(
            tx,
            {
              projectId,
              kind: "session_summary",
              title,
              bodyMd: input.summaryMd,
              tags,
              data,
              dedupeKey,
            },
            actor,
          );
          return { entry: toKbEntryDetail(row, null), created: true };
        }
        const [row] = await tx
          .update(kbEntries)
          .set({
            title,
            bodyMd: input.summaryMd,
            data,
            ...(input.tags === undefined ? {} : { tags }),
            updatedAt: bumpedUpdatedAt,
          })
          .where(eq(kbEntries.id, existing.id))
          .returning(entryColumns);
        if (row === undefined) {
          throw new Error("session summary vanished inside its transaction");
        }
        await audit(tx, {
          ...auditActor(actor),
          action: "kb.entry.update",
          targetType: "kb_entry",
          targetId: row.id,
          data: { projectId, fields: ["title", "bodyMd", "data"] },
        });
        publishUpdated(tx, row);
        return { entry: toKbEntryDetail(row, null), created: false };
      });
    },

    capture(projectId, input, actor) {
      return transaction(db, async (tx) => {
        await requireActiveProject(tx, projectId);
        await requireConversation(tx, projectId, input.conversationId);
        const rows = await tx
          .select({ id: messages.id, role: messages.role, content: messages.content })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, input.conversationId),
              inArray(messages.id, input.messageIds),
            ),
          )
          .orderBy(asc(messages.createdAt), asc(messages.id));
        if (rows.length !== input.messageIds.length) {
          throw validationFailed([
            { path: "messageIds", message: "Every message must belong to the conversation" },
          ]);
        }
        const blocks: string[] = [];
        for (const row of rows) {
          const label = SPEAKER_LABELS[row.role];
          if (label === undefined) {
            throw validationFailed([
              {
                path: "messageIds",
                message: "Only your messages and producer replies can be saved",
              },
            ]);
          }
          blocks.push(`${label}\n${row.content.text.trim()}`);
        }
        const bodyMd = blocks.join("\n\n");
        if (bodyMd.length > MAX_KB_BODY_LENGTH) {
          throw validationFailed([
            { path: "messageIds", message: "The selected messages are too long for one entry" },
          ]);
        }
        const row = await insertEntry(
          tx,
          {
            projectId,
            kind: input.kind,
            title: input.title,
            bodyMd,
            tags: normalizeTags(input.tags ?? []),
            data: { messageIds: rows.map((message) => message.id) },
            conversationId: input.conversationId,
          },
          actor,
        );
        return toKbEntryDetail(row, null);
      });
    },

    get,

    async list(projectId, query = {}) {
      if (!(await projectExists(db, projectId))) {
        return null;
      }
      const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
      const conditions: (SQL | undefined)[] = [
        eq(kbEntries.projectId, projectId),
        isNull(kbEntries.deletedAt),
      ];
      if (query.kinds !== undefined) {
        conditions.push(inArray(kbEntries.kind, query.kinds));
      }
      if (query.tag !== undefined) {
        conditions.push(arrayContains(kbEntries.tags, [query.tag]));
      }
      if (query.cursor !== undefined) {
        const cursor = decodeKbCursor(query.cursor);
        conditions.push(
          sql`(${kbEntries.updatedAt}, ${kbEntries.id}) < (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ ...entryColumns, cursorAt: cursorTimestamp })
        .from(kbEntries)
        .where(and(...conditions))
        .orderBy(desc(kbEntries.updatedAt), desc(kbEntries.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > limit && last !== undefined ? encodeKbCursor(last.cursorAt, last.id) : null;
      return {
        items: page.map(({ cursorAt: _cursorAt, ...row }) => toKbEntry(row)),
        nextCursor,
      };
    },

    async tags(projectId) {
      if (!(await projectExists(db, projectId))) {
        return null;
      }
      const result = await db.execute<{ tag: string; count: number }>(sql`
        select tag, count(*)::int as count
        from ${kbEntries}, unnest(${kbEntries.tags}) as tag
        where ${kbEntries.projectId} = ${projectId} and ${kbEntries.deletedAt} is null
        group by tag
        order by count desc, tag asc
      `);
      return result.rows.map((row) => ({ tag: row.tag, count: Number(row.count) }));
    },

    update(id, input, actor) {
      return transaction(db, async (tx) => {
        const existing = await lockEntry(tx, id);
        if (existing === null) {
          return null;
        }
        if (Date.parse(input.expectedUpdatedAt) !== existing.updatedAt.getTime()) {
          throw conflict("The entry was changed since you loaded it.", {
            reason: "stale",
            updatedAt: existing.updatedAt.toISOString(),
          });
        }
        const allowed = new Set<string>([
          ...COMMON_UPDATE_FIELDS,
          ...KIND_UPDATE_FIELDS[existing.kind],
        ]);
        const fields = Object.entries(input)
          .filter(([key, value]) => key !== "expectedUpdatedAt" && value !== undefined)
          .map(([key]) => key);
        const invalid = fields.filter((field) => !allowed.has(field));
        if (invalid.length > 0) {
          throw validationFailed(
            invalid.map((field) => ({
              path: field,
              message: `Not a field of a ${existing.kind.replace("_", " ")} entry`,
            })),
          );
        }

        const values: Partial<NewKbEntryRow> = {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.bodyMd === undefined ? {} : { bodyMd: input.bodyMd }),
          ...(input.tags === undefined ? {} : { tags: normalizeTags(input.tags) }),
        };
        if (existing.kind === "decision") {
          const data = decisionData(existing.data, input);
          if (data !== null) {
            values.data = data;
          }
        }
        let reference: KbReferenceRow | null = null;
        if (existing.kind === "reference") {
          const extra = await updateReference(tx, existing.id, input);
          reference = extra.reference;
          if (extra.searchExtra !== undefined) {
            values.searchExtra = extra.searchExtra;
          }
        }

        const [row] = await tx
          .update(kbEntries)
          .set({ ...values, updatedAt: bumpedUpdatedAt })
          .where(eq(kbEntries.id, existing.id))
          .returning(entryColumns);
        if (row === undefined) {
          return null;
        }
        await audit(tx, {
          ...auditActor(actor),
          action: "kb.entry.update",
          targetType: "kb_entry",
          targetId: row.id,
          data: { projectId: row.projectId, fields },
        });
        publishUpdated(tx, row);
        return toKbEntryDetail(row, reference);
      });
    },

    softDelete(id, actor) {
      return transaction(db, async (tx) => {
        const existing = await lockEntry(tx, id);
        if (existing === null) {
          return false;
        }
        await tx
          .update(kbEntries)
          .set({ deletedAt: sql`now()`, updatedAt: bumpedUpdatedAt })
          .where(eq(kbEntries.id, existing.id));
        await audit(tx, {
          ...auditActor(actor),
          action: "kb.entry.delete",
          targetType: "kb_entry",
          targetId: existing.id,
          data: { projectId: existing.projectId, kind: existing.kind },
        });
        const payload = { entryId: existing.id, projectId: existing.projectId };
        afterCommit(tx, () => bus.publish({ type: "kb.entry.deleted", payload }));
        return true;
      });
    },
  };
}

/**
 * The decision `data` after an update, or null when no decision field changed. Reactivating a
 * superseded decision drops its `supersededBy` link.
 */
function decisionData(current: JsonObject, input: UpdateKbEntry): JsonObject | null {
  if (input.decision === undefined && input.rationale === undefined && input.status === undefined) {
    return null;
  }
  const next: JsonObject = { ...current };
  if (input.decision !== undefined) {
    next.decision = input.decision;
  }
  if (input.rationale === null || input.rationale === "") {
    delete next.rationale;
  } else if (input.rationale !== undefined) {
    next.rationale = input.rationale;
  }
  if (input.status !== undefined) {
    next.status = input.status;
    if (input.status === "active") {
      delete next.supersededBy;
    }
  }
  const parsed = parseKbEntryData("decision", next);
  if (!parsed.success) {
    throw validationFailed([{ path: "decision", message: "The decision is not valid" }]);
  }
  return next;
}

/**
 * Applies the reference fields of an update. Returns the reference row and, when the searchable
 * reference text changed, the new `search_extra`.
 */
async function updateReference(
  tx: Transaction,
  entryId: string,
  input: UpdateKbEntry,
): Promise<{ reference: KbReferenceRow | null; searchExtra?: string }> {
  const current = await loadReference(tx, entryId);
  if (current === null) {
    return { reference: null };
  }
  const values = {
    ...(input.author === undefined ? {} : { author: optionalText(input.author) }),
    ...(input.likedReason === undefined ? {} : { likedReason: optionalText(input.likedReason) }),
    ...(input.transcript === undefined ? {} : { transcript: optionalText(input.transcript) }),
  };
  if (Object.keys(values).length === 0) {
    return { reference: current };
  }
  const [reference] = await tx
    .update(kbReferences)
    .set(values)
    .where(eq(kbReferences.entryId, entryId))
    .returning();
  const next = reference ?? current;
  return { reference: next, searchExtra: referenceSearchText(next) };
}
