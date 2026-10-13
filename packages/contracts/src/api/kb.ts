import { z } from "zod";
import { IdSchema, JsonObjectSchema, TimestampSchema } from "../common";
import {
  KB_ENTRY_KINDS,
  KbCreatedViaSchema,
  type KbEntryKind,
  KbEntryKindSchema,
  ReferenceAnalysisStatusSchema,
  ReferencePlatformSchema,
} from "../enums";
import { ReferenceAnalysisSchema } from "../kb/analysis";
import { normalizeReferenceUrl, REFERENCE_URL_MAX_LENGTH } from "../util/reference-url";
import { CursorPageQuerySchema } from "./common";

export const KB_TITLE_MAX_LENGTH = 200;

/** Longest markdown body of an entry, including bodies built from a captured conversation. */
export const MAX_KB_BODY_LENGTH = 200_000;

/** Longest reference transcript, in UTF-16 code units. */
export const MAX_TRANSCRIPT_LENGTH = 200_000;

export const KB_DECISION_MAX_LENGTH = 2_000;
export const KB_RATIONALE_MAX_LENGTH = 10_000;
export const KB_LIKED_REASON_MAX_LENGTH = 2_000;
export const KB_AUTHOR_MAX_LENGTH = 200;

export const KB_MAX_TAGS = 20;

/** A tag: lowercase letters, digits and hyphens, starting with a letter or digit, 1 to 40 long. */
export const KB_TAG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Most messages one capture may copy into an entry. */
export const KB_CAPTURE_MAX_MESSAGES = 200;

export const KB_SEARCH_QUERY_MAX_LENGTH = 200;
export const KB_SEARCH_DEFAULT_LIMIT = 20;
export const KB_SEARCH_MAX_LIMIT = 50;

/**
 * Search snippets mark each match with these control characters instead of HTML, so a client
 * never renders markup from stored text. Use `splitKbSnippet` to turn a snippet into parts.
 */
export const KB_SNIPPET_MATCH_START = "\u0002";
export const KB_SNIPPET_MATCH_END = "\u0003";

/** Trimmed and lowercased before the pattern is checked, so `Rust` is stored as `rust`. */
export const KbTagSchema = z.string().trim().toLowerCase().regex(KB_TAG_RE, {
  message: "Use 1 to 40 lowercase letters, digits and hyphens, starting with a letter or digit",
});

/** At most 20 tags, without repeats. */
export const KbTagsSchema = z
  .array(KbTagSchema)
  .max(KB_MAX_TAGS)
  .refine((tags) => new Set(tags).size === tags.length, { message: "Tags must not repeat" });

export const KbTitleSchema = z.string().trim().min(1).max(KB_TITLE_MAX_LENGTH);
export const KbBodySchema = z.string().max(MAX_KB_BODY_LENGTH);

/**
 * Whether `text` is free of C0 control characters (other than tab, line feed and carriage return)
 * and of lone surrogates. JSON escapes both as six bytes, so text without them stays at most three
 * UTF-8 bytes per code unit on the wire.
 */
export function isPlainText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * A transcript. Control characters and lone surrogates are rejected: transcripts are untrusted
 * text, and without them a maximum-length transcript still fits in one bridge frame as JSON.
 */
export const TranscriptSchema = z
  .string()
  .max(MAX_TRANSCRIPT_LENGTH)
  .refine((text) => text.trim().length > 0, { message: "The transcript must not be empty" })
  .refine(isPlainText, {
    message: "The transcript contains control characters",
  });

/**
 * A reference link as typed by the user: anything `normalizeReferenceUrl` accepts. The API stores
 * the normalised form.
 */
export const ReferenceUrlInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(REFERENCE_URL_MAX_LENGTH)
  .refine(isReferenceUrl, { message: "Enter an http or https link" });

function isReferenceUrl(value: string): boolean {
  try {
    normalizeReferenceUrl(value);
    return true;
  } catch {
    return false;
  }
}

/** A stored reference URL: absolute, http or https, already normalised. */
export const ReferenceUrlSchema = z.url({ protocol: /^https?$/ }).max(REFERENCE_URL_MAX_LENGTH);

/** `data` of a decision entry. Superseding a decision marks the old one and links the new one. */
export const DECISION_STATUSES = ["active", "superseded"] as const;
export const DecisionStatusSchema = z.enum(DECISION_STATUSES);
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DecisionDataSchema = z.object({
  decision: z.string().trim().min(1).max(KB_DECISION_MAX_LENGTH),
  rationale: z.string().trim().max(KB_RATIONALE_MAX_LENGTH).optional(),
  status: DecisionStatusSchema,
  /** The decision that replaced this one. */
  supersededBy: IdSchema.optional(),
});
export type DecisionData = z.infer<typeof DecisionDataSchema>;

/** `data` of a brainstorm or note: where it came from, when known. */
export const CapturedDataSchema = z.object({
  /** Producer session or client conversation the text was saved from. */
  sessionRef: z.string().min(1).max(200).optional(),
  /** Messages copied by a capture, in order. */
  messageIds: z.array(IdSchema).max(KB_CAPTURE_MAX_MESSAGES).optional(),
});
export type CapturedData = z.infer<typeof CapturedDataSchema>;

/** `data` of a session summary written by the session-end hook. */
export const SessionSummaryDataSchema = z.object({
  sessionId: z.string().min(1).max(200),
  cwd: z.string().max(1_024).optional(),
});
export type SessionSummaryData = z.infer<typeof SessionSummaryDataSchema>;

/**
 * The `data` schema of each entry kind. A reference keeps its details in `KbReferenceDetail`, so
 * its `data` is empty.
 */
export const KB_ENTRY_DATA = {
  brainstorm: CapturedDataSchema,
  reference: z.object({}),
  decision: DecisionDataSchema,
  note: CapturedDataSchema,
  session_summary: SessionSummaryDataSchema,
} as const satisfies Record<KbEntryKind, z.ZodType>;

export type KbEntryData<K extends KbEntryKind> = z.output<(typeof KB_ENTRY_DATA)[K]>;

const typedKbEntryData: { readonly [K in KbEntryKind]: z.ZodType<KbEntryData<K>> } = KB_ENTRY_DATA;

/** Validates an entry's `data` against the schema of its kind. */
export function parseKbEntryData<K extends KbEntryKind>(
  kind: K,
  data: unknown,
): z.ZodSafeParseResult<KbEntryData<K>> {
  return typedKbEntryData[kind].safeParse(data);
}

/**
 * A knowledge-base entry as listed and sent in live events. A reference's transcript and analysis
 * are in `KbEntryDetail.reference` only, which keeps lists and events small.
 */
export const KbEntrySchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  kind: KbEntryKindSchema,
  title: z.string(),
  bodyMd: z.string(),
  tags: z.array(z.string()),
  /** Kind-specific data; see `KB_ENTRY_DATA`. */
  data: JsonObjectSchema,
  /** The normalised URL of a reference, otherwise null. */
  sourceUrl: z.string().nullable(),
  /** The conversation an entry was captured from or written in. */
  conversationId: IdSchema.nullable(),
  createdVia: KbCreatedViaSchema,
  createdBy: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type KbEntry = z.infer<typeof KbEntrySchema>;

/** The reference part of a `reference` entry (`kb_references`). */
export const KbReferenceDetailSchema = z.object({
  url: z.string(),
  platform: ReferencePlatformSchema,
  author: z.string().nullable(),
  likedReason: z.string().nullable(),
  /** Untrusted text supplied by the user. Never render it as HTML. */
  transcript: z.string().nullable(),
  analysis: ReferenceAnalysisSchema.nullable(),
  analysisStatus: ReferenceAnalysisStatusSchema,
  /** The latest `kb.analyze_reference` job. */
  analysisJobId: IdSchema.nullable(),
  analyzedAt: TimestampSchema.nullable(),
});
export type KbReferenceDetail = z.infer<typeof KbReferenceDetailSchema>;

/** One entry with everything about it. `reference` is set for `reference` entries only. */
export const KbEntryDetailSchema = KbEntrySchema.extend({
  reference: KbReferenceDetailSchema.nullable(),
});
export type KbEntryDetail = z.infer<typeof KbEntryDetailSchema>;

const CreateTextEntryFields = {
  title: KbTitleSchema,
  bodyMd: KbBodySchema,
  tags: KbTagsSchema.optional(),
};

/**
 * Creates an entry in the web app. Session summaries are written only through MCP. A decision with
 * `supersedes` marks that decision as superseded by the new one.
 */
export const CreateKbEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("brainstorm"), ...CreateTextEntryFields }),
  z.object({ kind: z.literal("note"), ...CreateTextEntryFields }),
  z.object({
    kind: z.literal("decision"),
    title: KbTitleSchema,
    decision: DecisionDataSchema.shape.decision,
    rationale: DecisionDataSchema.shape.rationale,
    supersedes: IdSchema.optional(),
    tags: KbTagsSchema.optional(),
  }),
  z.object({
    kind: z.literal("reference"),
    url: ReferenceUrlInputSchema,
    /** Defaults to a title derived from the platform and author. */
    title: KbTitleSchema.optional(),
    likedReason: z.string().trim().max(KB_LIKED_REASON_MAX_LENGTH).optional(),
    author: z.string().trim().max(KB_AUTHOR_MAX_LENGTH).optional(),
    transcript: TranscriptSchema.optional(),
    tags: KbTagsSchema.optional(),
  }),
]);
export type CreateKbEntry = z.infer<typeof CreateKbEntrySchema>;

/**
 * Partial update. `expectedUpdatedAt` is the `updatedAt` the client last saw; when the entry has
 * changed since, the API answers `409 conflict` and changes nothing. Fields that do not apply to
 * the entry's kind are rejected with `400 validation_failed`. A reference's URL never changes.
 */
export const UpdateKbEntrySchema = z
  .object({
    expectedUpdatedAt: TimestampSchema,
    title: KbTitleSchema.optional(),
    bodyMd: KbBodySchema.optional(),
    tags: KbTagsSchema.optional(),
    /** Decision entries. */
    decision: DecisionDataSchema.shape.decision.optional(),
    rationale: z.string().trim().max(KB_RATIONALE_MAX_LENGTH).nullable().optional(),
    status: DecisionStatusSchema.optional(),
    /** Reference entries. */
    likedReason: z.string().trim().max(KB_LIKED_REASON_MAX_LENGTH).nullable().optional(),
    author: z.string().trim().max(KB_AUTHOR_MAX_LENGTH).nullable().optional(),
    transcript: TranscriptSchema.nullable().optional(),
  })
  .refine(
    (update) =>
      Object.entries(update).some(
        ([key, value]) => key !== "expectedUpdatedAt" && value !== undefined,
      ),
    { message: "Provide at least one field to update" },
  );
export type UpdateKbEntry = z.infer<typeof UpdateKbEntrySchema>;

/**
 * Entry kinds in a query string: a comma-separated list (`kinds=brainstorm,decision`) or repeated
 * values, already split into an array.
 */
export const KbKindsQuerySchema = z.union([
  z.array(KbEntryKindSchema).max(KB_ENTRY_KINDS.length),
  z
    .string()
    .transform((value) => value.split(",").map((kind) => kind.trim()))
    .pipe(z.array(KbEntryKindSchema).min(1).max(KB_ENTRY_KINDS.length)),
]);

/** `GET /api/projects/:projectId/kb`: newest first, cursor-paginated. */
export const ListKbQuerySchema = CursorPageQuerySchema.extend({
  kinds: KbKindsQuerySchema.optional(),
  tag: KbTagSchema.optional(),
});
export type ListKbQuery = z.infer<typeof ListKbQuerySchema>;

/** Full-text search over titles, tags and bodies. Without `projectId` it searches every project. */
export const KbSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(KB_SEARCH_QUERY_MAX_LENGTH),
  projectId: IdSchema.optional(),
  kinds: KbKindsQuerySchema.optional(),
  /** Defaults to `KB_SEARCH_DEFAULT_LIMIT`. */
  limit: z.coerce.number().int().min(1).max(KB_SEARCH_MAX_LIMIT).optional(),
});
export type KbSearchQuery = z.infer<typeof KbSearchQuerySchema>;

/** One search result. `snippet` marks matches with `KB_SNIPPET_MATCH_START` and `_END`. */
export const KbSearchHitSchema = z.object({
  entryId: IdSchema,
  projectId: IdSchema,
  kind: KbEntryKindSchema,
  title: z.string(),
  snippet: z.string().max(2_000),
  /** Relevance; higher is better. Only comparable within one response. */
  score: z.number().min(0),
});
export type KbSearchHit = z.infer<typeof KbSearchHitSchema>;

/**
 * Copies messages of a conversation into a new brainstorm or note. The messages must belong to
 * the conversation; they are joined in their stored order.
 */
export const CaptureConversationSchema = z.object({
  conversationId: IdSchema,
  messageIds: z
    .array(IdSchema)
    .min(1)
    .max(KB_CAPTURE_MAX_MESSAGES)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Messages must not repeat" }),
  title: KbTitleSchema,
  kind: z.enum(["brainstorm", "note"]),
  tags: KbTagsSchema.optional(),
});
export type CaptureConversation = z.infer<typeof CaptureConversationSchema>;

/** A tag in use in a project, with the number of entries carrying it. */
export const KbTagCountSchema = z.object({
  tag: z.string(),
  count: z.number().int().min(1),
});
export type KbTagCount = z.infer<typeof KbTagCountSchema>;

export interface KbSnippetPart {
  text: string;
  /** True for text between the match sentinels. */
  match: boolean;
}

/**
 * Splits a search snippet at its match sentinels, so a client can highlight matches with
 * elements instead of injecting markup. Unbalanced sentinels are tolerated and never returned.
 */
export function splitKbSnippet(snippet: string): KbSnippetPart[] {
  const parts: KbSnippetPart[] = [];
  let match = false;
  let text = "";
  const flush = () => {
    if (text.length > 0) parts.push({ text, match });
    text = "";
  };
  for (const char of snippet) {
    if (char === KB_SNIPPET_MATCH_START) {
      flush();
      match = true;
    } else if (char === KB_SNIPPET_MATCH_END) {
      flush();
      match = false;
    } else {
      text += char;
    }
  }
  flush();
  return parts;
}
