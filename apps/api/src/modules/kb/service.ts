import {
  type CaptureConversation,
  type CursorPage,
  DEFAULT_PAGE_LIMIT,
  type DecisionData,
  IdSchema,
  type JobStatus,
  type JsonObject,
  KB_MAX_TAGS,
  KB_TITLE_MAX_LENGTH,
  type KbCreatedVia,
  type KbEntry,
  type KbEntryDetail,
  type KbEntryKind,
  type KbSearchHit,
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
  assets,
  conversations,
  type Database,
  type JobRow,
  type KbReferenceRow,
  kbEntries,
  kbReferences,
  kbSearch,
  messages,
  type NewKbEntryRow,
  workspaces,
} from "@loomcast/db";
import { and, arrayContains, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import { sha256Hex } from "../../lib/crypto";
import { afterCommit, type Executor, type Transaction, transaction } from "../../lib/db";
import { conflict, notFound, validationFailed } from "../../lib/errors";
import type { JobsService } from "../jobs/service";
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
 * its user, so `userId` becomes `created_by` and the token is kept in `created_by_token_id`. A
 * studio agent storing a job result (`device`) acts for the user who started the job.
 */
export interface KbActor {
  kind: "user" | "token" | "device";
  /** The user id, the token id for `token`, or the device id for `device`. */
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
  /** A decision of the same workspace that this one replaces. */
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
  /**
   * A ready `reference_media` asset of the same workspace, uploaded by the user. It is analysed when
   * the reference has no transcript.
   */
  mediaAssetId?: string;
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
   * Creates an entry and publishes `kb.entry.created` once committed. 404 for an unknown workspace,
   * 409 for an archived one. A decision with `supersedes` marks that decision `superseded` and
   * links both, in the same transaction.
   */
  create(workspaceId: string, input: NewKbEntry, actor: KbActor): Promise<KbEntryDetail>;
  /**
   * Writes the summary of a working session, keyed by `session:<sessionId>`: a second call for the
   * same session replaces the summary instead of adding an entry.
   */
  saveSessionSummary(
    workspaceId: string,
    input: SessionSummaryInput,
    actor: KbActor,
  ): Promise<SessionSummaryResult>;
  /**
   * Copies messages of a conversation into a new brainstorm or note, as `**You:**` and
   * `**Producer:**` blocks in the order they were posted.
   */
  capture(workspaceId: string, input: CaptureConversation, actor: KbActor): Promise<KbEntryDetail>;
  /** An entry that is not deleted, or null. */
  get(id: string, executor?: Executor): Promise<KbEntryDetail | null>;
  /** Entries of a workspace, most recently updated first. Null when the workspace is unknown. */
  list(workspaceId: string, query?: ListKbQuery): Promise<CursorPage<KbEntry> | null>;
  /** Tags in use in a workspace with their entry counts, most used first. Null for no workspace. */
  tags(workspaceId: string): Promise<KbTagCount[] | null>;
  /**
   * Applies a partial update and publishes `kb.entry.updated`. 409 when `expectedUpdatedAt` is
   * not the entry's current `updatedAt`; 400 for fields that do not apply to the entry's kind.
   * Null when there is no such entry.
   */
  update(id: string, input: UpdateKbEntry, actor: KbActor): Promise<KbEntryDetail | null>;
  /** Soft-deletes an entry and publishes `kb.entry.deleted`. False when there is no such entry. */
  softDelete(id: string, actor: KbActor): Promise<boolean>;
  /**
   * Ranked full-text search over live entries (`kbSearch`): within one workspace when `workspaceId`
   * is given, otherwise across every workspace.
   */
  search(options: KbSearchOptions): Promise<KbSearchHit[]>;
  /**
   * Queues `kb.analyze_reference` for a reference with a transcript (or, without one, uploaded
   * media) and marks its analysis `queued`. The idempotency key is
   * `analyze:<entryId>:<sha256(transcript)>` (`analyze:<entryId>:media:<assetId>` for media), so
   * asking twice for the same transcript returns the job already queued or running. A failed or
   * cancelled analysis, or a finished one the reference no longer shows, is run again under a key
   * chained on that job. 409 for an entry that is not a reference or has neither; null when there
   * is no such entry.
   */
  analyze(id: string, actor: KbActor): Promise<AnalyzeResult | null>;
  /**
   * Like `create`, on the caller's transaction, for server-side writers such as competitor
   * research. The caller has checked the workspace (`requireActiveWorkspace`).
   */
  createIn(
    tx: Transaction,
    workspaceId: string,
    input: NewTextEntry | NewDecisionEntry,
    actor: KbActor,
  ): Promise<KbEntryDetail>;
  /**
   * The workspace's live reference for `input.url`, created when there is none, on the caller's
   * transaction. An existing entry keeps its fields and gains the tags of `input` it lacks. 400
   * for a URL that cannot be normalised. The caller has checked the workspace.
   */
  ensureReference(
    tx: Transaction,
    workspaceId: string,
    input: NewReferenceEntry,
    actor: KbActor,
  ): Promise<EnsuredReference>;
  /**
   * Queues `kb.analyze_reference` with `fetchPublicVideo` for a reference, on the caller's
   * transaction, and marks its analysis `queued`, as `analyze` does. A job of the reference that
   * is still queued or running is returned instead of a new one. Null when the entry is not a
   * live reference.
   */
  queuePublicVideoAnalysis(
    tx: Transaction,
    entryId: string,
    idempotencyKey: string,
    actor: KbActor,
  ): Promise<JobRow | null>;
}

export interface EnsuredReference {
  entry: EntryRow;
  reference: KbReferenceRow;
  /** False when the workspace already had a live reference for the URL. */
  created: boolean;
}

export interface AnalyzeResult {
  job: JobRow;
  /** False when a job for the same transcript was already queued or running. */
  created: boolean;
}

export interface KbSearchOptions {
  q: string;
  workspaceId?: string;
  kinds?: readonly KbEntryKind[];
  limit?: number;
}

export interface KbServiceDeps {
  db: Database;
  bus: EventBus;
  jobs: JobsService;
}

/** Job statuses in which an analysis is still on its way. */
const ACTIVE_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(["queued", "dispatched", "running"]);

/** Longest chain of re-runs `analyze` follows before giving up. */
const MAX_ANALYSIS_KEY_CHAIN = 100;

/** The base idempotency key of an analysis of `transcript`. */
export function analysisKey(entryId: string, transcript: string): string {
  return `analyze:${entryId}:${sha256Hex(transcript)}`;
}

/** The base idempotency key of an analysis of uploaded media, for a reference without a transcript. */
export function mediaAnalysisKey(entryId: string, mediaAssetId: string): string {
  return `analyze:${entryId}:media:${mediaAssetId}`;
}

/** Throws unless `assetId` is a ready `reference_media` asset of the workspace. */
async function requireReferenceMedia(
  executor: Executor,
  workspaceId: string,
  assetId: string,
): Promise<void> {
  const [asset] = await executor
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        eq(assets.id, assetId),
        eq(assets.workspaceId, workspaceId),
        eq(assets.kind, "reference_media"),
        eq(assets.status, "ready"),
      ),
    )
    .limit(1);
  if (asset === undefined) {
    throw validationFailed([
      {
        path: "mediaAssetId",
        message: "No uploaded reference media with that id in this workspace",
      },
    ]);
  }
}

/** The fields `update` accepts for every kind, and the extra ones per kind. */
const COMMON_UPDATE_FIELDS = ["title", "bodyMd", "tags"] as const;
const KIND_UPDATE_FIELDS: { readonly [K in KbEntryKind]: readonly string[] } = {
  brainstorm: [],
  note: [],
  session_summary: [],
  decision: ["decision", "rationale", "status"],
  reference: ["likedReason", "author", "transcript", "mediaAssetId"],
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

export const archivedWorkspace = () =>
  conflict("The workspace is archived. Restore it before adding to it.", { reason: "archived" });

export const workspaceNotFound = () => notFound("Workspace not found.");

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
 * Throws unless the workspace exists and is active. Takes a share lock, so the workspace cannot be
 * archived while the entry is written.
 */
export async function requireActiveWorkspace(tx: Transaction, workspaceId: string): Promise<void> {
  if (!IdSchema.safeParse(workspaceId).success) {
    throw workspaceNotFound();
  }
  const [workspace] = await tx
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
    .for("share");
  if (workspace === undefined) {
    throw workspaceNotFound();
  }
  if (workspace.status === "archived") {
    throw archivedWorkspace();
  }
}

async function workspaceExists(executor: Executor, workspaceId: string): Promise<boolean> {
  if (!IdSchema.safeParse(workspaceId).success) {
    return false;
  }
  const [row] = await executor
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row !== undefined;
}

/** A conversation id of this workspace, or a 404. */
async function requireConversation(
  executor: Executor,
  workspaceId: string,
  conversationId: string,
): Promise<void> {
  const [row] = await executor
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)))
    .limit(1);
  if (row === undefined) {
    throw notFound("No conversation with that id in this workspace.");
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
  const { db, bus, jobs } = deps;

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
   * Like `insertEntry`, but a `dedupeKey` already used by a live entry of the workspace inserts
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
        target: [kbEntries.workspaceId, kbEntries.dedupeKey],
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
      data: { workspaceId: row.workspaceId, kind: row.kind, via: row.createdVia },
    });
    publishCreated(tx, row);
    return row;
  }

  /** Marks `oldId` superseded by `newId`. The old decision must be active, in the same workspace. */
  async function supersede(tx: Transaction, workspaceId: string, oldId: string): Promise<EntryRow> {
    const old = await lockEntry(tx, oldId);
    if (old === null || old.workspaceId !== workspaceId || old.kind !== "decision") {
      throw validationFailed([
        { path: "supersedes", message: "No decision with that id in this workspace" },
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
      data: { workspaceId: row.workspaceId, fields: ["status"], supersededBy: newId },
    });
    publishUpdated(tx, row);
  }

  async function createText(
    tx: Transaction,
    workspaceId: string,
    input: NewTextEntry,
    actor: KbActor,
  ): Promise<KbEntryDetail> {
    const data: JsonObject = input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef };
    const row = await insertEntry(
      tx,
      {
        workspaceId,
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
    workspaceId: string,
    input: NewDecisionEntry,
    actor: KbActor,
  ): Promise<KbEntryDetail> {
    const old =
      input.supersedes === undefined ? null : await supersede(tx, workspaceId, input.supersedes);
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
        workspaceId,
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

  function normalizedReferenceUrl(url: string): ReturnType<typeof normalizeReferenceUrl> {
    try {
      return normalizeReferenceUrl(url);
    } catch {
      throw validationFailed([{ path: "url", message: "Enter an http or https link" }]);
    }
  }

  /** The live entry of the workspace with `dedupeKey`, locked for update, or null. */
  async function lockDedupedEntry(
    tx: Transaction,
    workspaceId: string,
    dedupeKey: string,
  ): Promise<EntryRow | null> {
    const [row] = await tx
      .select(entryColumns)
      .from(kbEntries)
      .where(
        and(
          eq(kbEntries.workspaceId, workspaceId),
          eq(kbEntries.dedupeKey, dedupeKey),
          isNull(kbEntries.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    return row ?? null;
  }

  /**
   * Inserts a reference entry and its `kb_references` row. Null, inserting nothing, when the
   * workspace already has a live reference for the normalised URL.
   */
  async function insertReference(
    tx: Transaction,
    workspaceId: string,
    input: NewReferenceEntry,
    actor: KbActor,
  ): Promise<{ row: EntryRow; reference: KbReferenceRow } | null> {
    const normalized = normalizedReferenceUrl(input.url);
    const platform = input.platform ?? normalized.platform;
    const author = optionalText(input.author);
    const likedReason = optionalText(input.likedReason);
    const transcript = optionalText(input.transcript);
    const analysis = input.analysis ?? null;
    const dedupeKey = referenceDedupeKey(normalized.url);
    if (input.mediaAssetId !== undefined) {
      await requireReferenceMedia(tx, workspaceId, input.mediaAssetId);
    }

    const row = await tryInsertEntry(
      tx,
      {
        workspaceId,
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
      return null;
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
        mediaAssetId: input.mediaAssetId ?? null,
        analysis,
        analysisStatus: analysis === null ? "none" : "done",
        analyzedAt: analysis === null ? null : sql`now()`,
      })
      .returning();
    if (reference === undefined) {
      throw new Error("reference was not inserted");
    }
    return { row, reference };
  }

  async function createReference(
    tx: Transaction,
    workspaceId: string,
    input: NewReferenceEntry,
    actor: KbActor,
  ): Promise<KbEntryDetail> {
    const inserted = await insertReference(tx, workspaceId, input, actor);
    if (inserted === null) {
      const dedupeKey = referenceDedupeKey(normalizedReferenceUrl(input.url).url);
      const [existing] = await tx
        .select({ id: kbEntries.id })
        .from(kbEntries)
        .where(
          and(
            eq(kbEntries.workspaceId, workspaceId),
            eq(kbEntries.dedupeKey, dedupeKey),
            isNull(kbEntries.deletedAt),
          ),
        )
        .limit(1);
      throw conflict("This reference is already saved in the workspace.", {
        reason: "duplicate",
        entryId: existing?.id ?? null,
      });
    }
    return toKbEntryDetail(inserted.row, inserted.reference);
  }

  async function ensureReference(
    tx: Transaction,
    workspaceId: string,
    input: NewReferenceEntry,
    actor: KbActor,
  ): Promise<EnsuredReference> {
    const inserted = await insertReference(tx, workspaceId, input, actor);
    if (inserted !== null) {
      return { entry: inserted.row, reference: inserted.reference, created: true };
    }
    const dedupeKey = referenceDedupeKey(normalizedReferenceUrl(input.url).url);
    const existing = await lockDedupedEntry(tx, workspaceId, dedupeKey);
    const reference = existing === null ? null : await loadReference(tx, existing.id);
    if (existing === null || reference === null) {
      throw new Error("deduplicated reference vanished inside its transaction");
    }
    const tags = normalizeTags([...existing.tags, ...(input.tags ?? [])]);
    if (tags.length === existing.tags.length || tags.length > KB_MAX_TAGS) {
      return { entry: existing, reference, created: false };
    }
    const [row] = await tx
      .update(kbEntries)
      .set({ tags, updatedAt: bumpedUpdatedAt })
      .where(eq(kbEntries.id, existing.id))
      .returning(entryColumns);
    if (row === undefined) {
      throw new Error("reference vanished inside its transaction");
    }
    await audit(tx, {
      ...auditActor(actor),
      action: "kb.entry.update",
      targetType: "kb_entry",
      targetId: row.id,
      data: { workspaceId, fields: ["tags"] },
    });
    publishUpdated(tx, row);
    return { entry: row, reference, created: false };
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
    createIn(tx, workspaceId, input, actor) {
      return input.kind === "decision"
        ? createDecision(tx, workspaceId, input, actor)
        : createText(tx, workspaceId, input, actor);
    },

    ensureReference,

    async queuePublicVideoAnalysis(tx, entryId, idempotencyKey, actor) {
      const entry = await lockEntry(tx, entryId);
      if (entry === null || entry.kind !== "reference") {
        return null;
      }
      const [reference] = await tx
        .select()
        .from(kbReferences)
        .where(eq(kbReferences.entryId, entry.id))
        .limit(1)
        .for("update");
      if (reference === undefined) {
        return null;
      }
      const current =
        reference.analysisJobId === null ? null : await jobs.get(reference.analysisJobId, tx);
      if (current !== null && ACTIVE_JOB_STATUSES.has(current.status)) {
        return current;
      }
      const { job } = await jobs.enqueue(tx, {
        type: "kb.analyze_reference",
        payload: {
          workspaceId: entry.workspaceId,
          entryId: entry.id,
          url: reference.url,
          platform: reference.platform,
          fetchPublicVideo: true,
          ...(reference.likedReason === null ? {} : { likedReason: reference.likedReason }),
        },
        workspaceId: entry.workspaceId,
        conversationId: null,
        idempotencyKey,
        createdBy: actor.userId,
      });
      if (job.id !== reference.analysisJobId) {
        await tx
          .update(kbReferences)
          .set({
            analysisJobId: job.id,
            analysisStatus: job.status === "running" ? "running" : "queued",
          })
          .where(eq(kbReferences.entryId, entry.id));
        await audit(tx, {
          ...auditActor(actor),
          action: "kb.reference.analyze",
          targetType: "kb_entry",
          targetId: entry.id,
          data: { workspaceId: entry.workspaceId, jobId: job.id },
        });
        publishUpdated(tx, entry);
      }
      return job;
    },

    create(workspaceId, input, actor) {
      return transaction(db, async (tx) => {
        await requireActiveWorkspace(tx, workspaceId);
        if (input.conversationId != null) {
          await requireConversation(tx, workspaceId, input.conversationId);
        }
        switch (input.kind) {
          case "brainstorm":
          case "note":
            return createText(tx, workspaceId, input, actor);
          case "decision":
            return createDecision(tx, workspaceId, input, actor);
          case "reference":
            return createReference(tx, workspaceId, input, actor);
        }
      });
    },

    saveSessionSummary(workspaceId, input, actor) {
      return transaction(db, async (tx) => {
        await requireActiveWorkspace(tx, workspaceId);
        const dedupeKey = `session:${input.sessionId}`;
        // Serialises writers of the same session, so two calls never race to insert.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`loomcast:kb:${workspaceId}:${dedupeKey}`}))`,
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
              eq(kbEntries.workspaceId, workspaceId),
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
              workspaceId,
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
          data: { workspaceId, fields: ["title", "bodyMd", "data"] },
        });
        publishUpdated(tx, row);
        return { entry: toKbEntryDetail(row, null), created: false };
      });
    },

    capture(workspaceId, input, actor) {
      return transaction(db, async (tx) => {
        await requireActiveWorkspace(tx, workspaceId);
        await requireConversation(tx, workspaceId, input.conversationId);
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
            workspaceId,
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

    async list(workspaceId, query = {}) {
      if (!(await workspaceExists(db, workspaceId))) {
        return null;
      }
      const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
      const conditions: (SQL | undefined)[] = [
        eq(kbEntries.workspaceId, workspaceId),
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

    async tags(workspaceId) {
      if (!(await workspaceExists(db, workspaceId))) {
        return null;
      }
      const result = await db.execute<{ tag: string; count: number }>(sql`
        select tag, count(*)::int as count
        from ${kbEntries}, unnest(${kbEntries.tags}) as tag
        where ${kbEntries.workspaceId} = ${workspaceId} and ${kbEntries.deletedAt} is null
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
          const extra = await updateReference(tx, existing, input);
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
          data: { workspaceId: row.workspaceId, fields },
        });
        publishUpdated(tx, row);
        return toKbEntryDetail(row, reference);
      });
    },

    search(options) {
      return kbSearch(db, options);
    },

    analyze(id, actor) {
      return transaction(db, async (tx) => {
        const entry = await lockEntry(tx, id);
        if (entry === null) {
          return null;
        }
        const [reference] =
          entry.kind === "reference"
            ? await tx
                .select()
                .from(kbReferences)
                .where(eq(kbReferences.entryId, entry.id))
                .limit(1)
                .for("update")
            : [];
        if (reference === undefined) {
          throw conflict("Only references can be analysed.", { reason: "not_reference" });
        }
        // A transcript is analysed as it is; uploaded media only when there is no transcript.
        const { transcript, mediaAssetId } = reference;
        const source =
          transcript !== null
            ? { payload: { transcript }, baseKey: analysisKey(entry.id, transcript) }
            : mediaAssetId !== null
              ? { payload: { mediaAssetId }, baseKey: mediaAnalysisKey(entry.id, mediaAssetId) }
              : null;
        if (source === null) {
          throw conflict("Add a transcript or upload the video before analysing this reference.", {
            reason: "missing_transcript",
          });
        }
        const { baseKey } = source;

        // Someone already asked for this transcript and the job is still on its way.
        const current =
          reference.analysisJobId === null ? null : await jobs.get(reference.analysisJobId, tx);
        if (
          current !== null &&
          ACTIVE_JOB_STATUSES.has(current.status) &&
          current.idempotencyKey?.startsWith(baseKey) === true
        ) {
          return { job: current, created: false };
        }

        let key = baseKey;
        for (let attempt = 0; attempt < MAX_ANALYSIS_KEY_CHAIN; attempt += 1) {
          const { job, created } = await jobs.enqueue(tx, {
            type: "kb.analyze_reference",
            payload: {
              workspaceId: entry.workspaceId,
              entryId: entry.id,
              url: reference.url,
              platform: reference.platform,
              ...source.payload,
              ...(reference.likedReason === null ? {} : { likedReason: reference.likedReason }),
            },
            workspaceId: entry.workspaceId,
            conversationId: null,
            idempotencyKey: key,
            createdBy: actor.userId,
          });
          const reusable =
            !created &&
            (ACTIVE_JOB_STATUSES.has(job.status) ||
              (job.status === "succeeded" &&
                job.id === reference.analysisJobId &&
                reference.analysisStatus === "done"));
          if (!created && !reusable) {
            // Failed, cancelled, or a result the reference no longer shows: run it again.
            key = `${baseKey}:${job.id}`;
            continue;
          }
          if (job.id !== reference.analysisJobId) {
            await tx
              .update(kbReferences)
              .set({
                analysisJobId: job.id,
                analysisStatus: job.status === "running" ? "running" : "queued",
              })
              .where(eq(kbReferences.entryId, entry.id));
            await audit(tx, {
              ...auditActor(actor),
              action: "kb.reference.analyze",
              targetType: "kb_entry",
              targetId: entry.id,
              data: { workspaceId: entry.workspaceId, jobId: job.id },
            });
            publishUpdated(tx, entry);
          }
          return { job, created };
        }
        throw new Error("too many analyses of one transcript");
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
          data: { workspaceId: existing.workspaceId, kind: existing.kind },
        });
        const payload = { entryId: existing.id, workspaceId: existing.workspaceId };
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
  entry: EntryRow,
  input: UpdateKbEntry,
): Promise<{ reference: KbReferenceRow | null; searchExtra?: string }> {
  const current = await loadReference(tx, entry.id);
  if (current === null) {
    return { reference: null };
  }
  if (input.mediaAssetId != null) {
    await requireReferenceMedia(tx, entry.workspaceId, input.mediaAssetId);
  }
  const values = {
    ...(input.author === undefined ? {} : { author: optionalText(input.author) }),
    ...(input.likedReason === undefined ? {} : { likedReason: optionalText(input.likedReason) }),
    ...(input.transcript === undefined ? {} : { transcript: optionalText(input.transcript) }),
    ...(input.mediaAssetId === undefined ? {} : { mediaAssetId: input.mediaAssetId }),
  };
  if (Object.keys(values).length === 0) {
    return { reference: current };
  }
  const [reference] = await tx
    .update(kbReferences)
    .set(values)
    .where(eq(kbReferences.entryId, entry.id))
    .returning();
  const next = reference ?? current;
  return { reference: next, searchExtra: referenceSearchText(next) };
}
