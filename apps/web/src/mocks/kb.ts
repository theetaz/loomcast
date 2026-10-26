import {
  type ApiError,
  CaptureConversationSchema,
  CreateKbEntrySchema,
  DEFAULT_PAGE_LIMIT,
  type DecisionData,
  KB_SEARCH_DEFAULT_LIMIT,
  KB_SEARCH_MAX_LIMIT,
  KB_SNIPPET_MATCH_END,
  KB_SNIPPET_MATCH_START,
  type KbEntry,
  type KbEntryDetail,
  type KbEntryKind,
  KbKindsQuerySchema,
  type KbReferenceDetail,
  type KbSearchHit,
  MAX_PAGE_LIMIT,
  normalizeReferenceUrl,
  type ReferenceAnalysis,
  type ReferencePlatform,
  routes,
  UpdateKbEntrySchema,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { z } from "zod";
import { mockJob, updateJob } from "./conversations";
import { type MockDb, mockId, publish } from "./db";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");
const notFound = () => apiError(404, "not_found", "No knowledge entry has that id.");

function invalid(error: z.ZodError) {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return apiError(400, "validation_failed", `${where}${issue?.message ?? "Check the entry."}`);
}

const PLATFORM_NAMES: Record<ReferencePlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  threads: "Threads",
  x: "X",
  facebook: "Facebook",
  other: "Web",
};

/** The listed part of an entry, as lists and live events carry it. */
export function listedEntry(entry: KbEntryDetail): KbEntry {
  const { reference: _reference, ...rest } = entry;
  return rest;
}

/** A timestamp after `previous`, so two quick writes never share an `updatedAt`. */
function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

export function mockKbEntry(
  overrides: Partial<KbEntryDetail> & Pick<KbEntryDetail, "workspaceId" | "kind" | "title">,
): KbEntryDetail {
  const at = overrides.createdAt ?? new Date().toISOString();
  return {
    id: mockId(),
    bodyMd: "",
    tags: [],
    data: {},
    sourceUrl: null,
    conversationId: null,
    createdVia: "ui",
    createdBy: null,
    createdAt: at,
    updatedAt: at,
    reference: null,
    ...overrides,
  };
}

export function mockReferenceDetail(
  overrides: Partial<KbReferenceDetail> & Pick<KbReferenceDetail, "url" | "platform">,
): KbReferenceDetail {
  return {
    author: null,
    likedReason: null,
    transcript: null,
    analysis: null,
    analysisStatus: "none",
    analysisJobId: null,
    analyzedAt: null,
    ...overrides,
  };
}

function publishEntry(
  db: MockDb,
  type: "kb.entry.created" | "kb.entry.updated",
  entry: KbEntryDetail,
) {
  publish(db, { type, payload: { entry: listedEntry(entry) } });
}

/** Changes a stored entry, moves its `updatedAt` on and publishes `kb.entry.updated`. */
export function updateKbEntry(
  db: MockDb,
  id: string,
  change: (entry: KbEntryDetail) => void,
): KbEntryDetail | null {
  const entry = db.kbEntries.find((item) => item.id === id);
  if (!entry) return null;
  change(entry);
  entry.updatedAt = nextTimestamp(entry.updatedAt);
  publishEntry(db, "kb.entry.updated", entry);
  return entry;
}

// Search ----------------------------------------------------------------------

const SNIPPET_CONTEXT = 70;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A window of `text` around the first match, with every match wrapped in the sentinels. */
export function mockSnippet(text: string, needle: string): string {
  const flat = text
    .replaceAll(KB_SNIPPET_MATCH_START, "")
    .replaceAll(KB_SNIPPET_MATCH_END, "")
    .replace(/\s+/g, " ")
    .trim();
  const index = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return flat.slice(0, SNIPPET_CONTEXT * 2);
  const start = Math.max(0, index - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, index + needle.length + SNIPPET_CONTEXT);
  const window = flat.slice(start, end);
  const marked = window.replace(
    new RegExp(escapeRegExp(needle), "gi"),
    (match) => `${KB_SNIPPET_MATCH_START}${match}${KB_SNIPPET_MATCH_END}`,
  );
  return `${start > 0 ? "…" : ""}${marked}${end < flat.length ? "…" : ""}`;
}

function searchableFields(entry: KbEntryDetail): string[] {
  const data = entry.data as Partial<DecisionData>;
  return [
    entry.bodyMd,
    typeof data.decision === "string" ? data.decision : "",
    typeof data.rationale === "string" ? data.rationale : "",
    entry.reference?.likedReason ?? "",
    entry.reference?.transcript ?? "",
    entry.tags.join(" "),
  ].filter((field) => field.length > 0);
}

function countMatches(text: string, needle: string): number {
  return text.toLowerCase().split(needle.toLowerCase()).length - 1;
}

/** Case-insensitive substring search, scored by the number of matches; titles count double. */
export function searchKb(
  db: MockDb,
  query: { q: string; workspaceId?: string; kinds?: KbEntryKind[]; limit?: number },
): KbSearchHit[] {
  const needle = query.q.trim();
  const hits: KbSearchHit[] = [];
  for (const entry of db.kbEntries) {
    if (query.workspaceId && entry.workspaceId !== query.workspaceId) continue;
    if (query.kinds && !query.kinds.includes(entry.kind)) continue;
    const fields = searchableFields(entry);
    const score =
      countMatches(entry.title, needle) * 2 +
      fields.reduce((sum, field) => sum + countMatches(field, needle), 0);
    if (score === 0) continue;
    const field = fields.find((text) => countMatches(text, needle) > 0) ?? entry.title;
    hits.push({
      entryId: entry.id,
      workspaceId: entry.workspaceId,
      kind: entry.kind,
      title: entry.title,
      snippet: mockSnippet(field, needle),
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, query.limit ?? KB_SEARCH_DEFAULT_LIMIT);
}

// The pretend analysis --------------------------------------------------------

export const DEMO_ANALYSIS: ReferenceAnalysis = {
  hook: {
    text: "Opens on the red compiler error before saying a word.",
    type: "pattern-interrupt",
    timeToHookMs: 1_200,
  },
  structure: [
    { label: "Hook", startMs: 0, endMs: 3_000, summary: "The failing line, zoomed in." },
    {
      label: "Why",
      startMs: 3_000,
      endMs: 18_000,
      summary: "One sentence on ownership, with the moved value highlighted.",
    },
    {
      label: "Fix",
      startMs: 18_000,
      endMs: 41_000,
      summary: "Borrow instead of move, typed live, then run again.",
    },
    { label: "Payoff", startMs: 41_000, endMs: 52_000, summary: "The rule as one caption." },
  ],
  pacing: {
    wordsPerMinute: 172,
    cutsPerMinute: 14,
    notes: "A cut or zoom every four seconds; no shot holds longer than six.",
  },
  retention: [
    {
      technique: "Open loop",
      evidence: "Promises the fix at 0:02 and pays it off at 0:41.",
    },
    {
      technique: "Visual progress",
      evidence: "A beat counter in the corner shows how far along the explanation is.",
    },
  ],
  visualStyle: "Dark editor, one accent colour for the moved value, captions in the lower third.",
  cta: "Follow for one Rust error a day.",
  takeaways: [
    "Show the error before explaining anything.",
    "Highlight exactly one token per beat.",
    "End on the corrected code running.",
  ],
  applicability:
    "Fits the series format: every episode can open on its compiler error and close on the fix running.",
};

const analysisTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

/** Plays a `kb.analyze_reference` job through its states and stores the analysis. */
export function runAnalysis(db: MockDb, entryId: string, jobId: string) {
  const device = db.devices.find((item) => item.online && item.revokedAt === null);
  if (!device || analysisTimers.has(jobId)) return;
  const timers: ReturnType<typeof setTimeout>[] = [];
  analysisTimers.set(jobId, timers);
  let at = 0;
  const step = (delay: number, action: () => void) => {
    at += delay;
    timers.push(setTimeout(action, at));
  };
  step(600, () =>
    updateJob(db, jobId, {
      status: "dispatched",
      claimedByDevice: device.id,
      dispatchedAt: new Date().toISOString(),
    }),
  );
  step(500, () => {
    updateJob(db, jobId, { status: "running", startedAt: new Date().toISOString() });
    updateKbEntry(db, entryId, (entry) => {
      if (entry.reference) entry.reference.analysisStatus = "running";
    });
  });
  step(2_400, () => {
    const now = new Date().toISOString();
    updateKbEntry(db, entryId, (entry) => {
      if (!entry.reference) return;
      entry.reference.analysis = DEMO_ANALYSIS;
      entry.reference.analysisStatus = "done";
      entry.reference.analyzedAt = now;
    });
    updateJob(db, jobId, { status: "succeeded", finishedAt: now });
    analysisTimers.delete(jobId);
  });
}

// Handlers --------------------------------------------------------------------

function parseKinds(url: URL): KbEntryKind[] | undefined | null {
  const values = url.searchParams.getAll("kinds");
  if (values.length === 0) return undefined;
  const parsed = KbKindsQuerySchema.safeParse(values.join(","));
  return parsed.success ? parsed.data : null;
}

function createEntry(db: MockDb, workspaceId: string, body: unknown) {
  const parsed = CreateKbEntrySchema.safeParse(body);
  if (!parsed.success) return { error: invalid(parsed.error) };
  const input = parsed.data;
  const base = { workspaceId, createdBy: db.user.id, tags: input.tags ?? [] };

  switch (input.kind) {
    case "brainstorm":
    case "note":
      return {
        entry: mockKbEntry({ ...base, kind: input.kind, title: input.title, bodyMd: input.bodyMd }),
      };
    case "decision": {
      const entry = mockKbEntry({
        ...base,
        kind: "decision",
        title: input.title,
        bodyMd: [input.decision, input.rationale].filter(Boolean).join("\n\n"),
        data: {
          decision: input.decision,
          ...(input.rationale ? { rationale: input.rationale } : {}),
          status: "active",
        } satisfies DecisionData,
      });
      if (input.supersedes) {
        const old = db.kbEntries.find(
          (item) =>
            item.id === input.supersedes &&
            item.kind === "decision" &&
            item.workspaceId === workspaceId,
        );
        if (!old) return { error: apiError(404, "not_found", "No decision has that id.") };
        return { entry, supersedes: old.id };
      }
      return { entry };
    }
    case "reference": {
      const { url, platform } = normalizeReferenceUrl(input.url);
      const author = input.author || null;
      const title =
        input.title ?? `${PLATFORM_NAMES[platform]} video${author ? ` by ${author}` : ""}`;
      return {
        entry: mockKbEntry({
          ...base,
          kind: "reference",
          title,
          bodyMd: input.likedReason ?? "",
          sourceUrl: url,
          reference: mockReferenceDetail({
            url,
            platform,
            author,
            likedReason: input.likedReason || null,
            transcript: input.transcript ?? null,
          }),
        }),
      };
    }
  }
}

/** Knowledge-base routes, following `@loomcast/contracts`. */
export function createKbHandlers(db: MockDb) {
  const findEntry = (id: string) => db.kbEntries.find((item) => item.id === id);
  const hasWorkspace = (id: string) => db.workspaces.some((workspace) => workspace.id === id);

  return [
    // Newest first; the cursor is the offset of the next page.
    http.get(path("kb.list"), ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const workspaceId = String(params.workspaceId);
      if (!hasWorkspace(workspaceId))
        return apiError(404, "not_found", "No workspace has that id.");
      const url = new URL(request.url);
      const kinds = parseKinds(url);
      if (kinds === null) return apiError(400, "validation_failed", "Unknown entry kind.");
      const tag = url.searchParams.get("tag");
      const offset = Number(url.searchParams.get("cursor") ?? 0) || 0;
      const limit = Math.min(
        MAX_PAGE_LIMIT,
        Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_LIMIT) || DEFAULT_PAGE_LIMIT,
      );
      const all = db.kbEntries
        .filter(
          (entry) =>
            entry.workspaceId === workspaceId &&
            (!kinds || kinds.includes(entry.kind)) &&
            (!tag || entry.tags.includes(tag)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const items = all.slice(offset, offset + limit).map(listedEntry);
      const next = offset + limit;
      return HttpResponse.json({ items, nextCursor: next < all.length ? String(next) : null });
    }),

    http.get(path("kb.tags"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const workspaceId = String(params.workspaceId);
      if (!hasWorkspace(workspaceId))
        return apiError(404, "not_found", "No workspace has that id.");
      const counts = new Map<string, number>();
      for (const entry of db.kbEntries) {
        if (entry.workspaceId !== workspaceId) continue;
        for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      const items = [...counts]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      return HttpResponse.json({ items });
    }),

    http.post(path("kb.create"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const workspaceId = String(params.workspaceId);
      if (!hasWorkspace(workspaceId))
        return apiError(404, "not_found", "No workspace has that id.");
      const result = createEntry(db, workspaceId, await request.json().catch(() => null));
      if ("error" in result) return result.error;
      db.kbEntries.push(result.entry);
      publishEntry(db, "kb.entry.created", result.entry);
      if (result.supersedes) {
        updateKbEntry(db, result.supersedes, (old) => {
          old.data = { ...old.data, status: "superseded", supersededBy: result.entry.id };
        });
      }
      return HttpResponse.json(result.entry, { status: 201 });
    }),

    http.post(path("kb.capture"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const workspaceId = String(params.workspaceId);
      const parsed = CaptureConversationSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const { conversationId, messageIds, title, kind, tags } = parsed.data;
      const messages = db.messages.filter(
        (message) => message.conversationId === conversationId && messageIds.includes(message.id),
      );
      const entry = mockKbEntry({
        workspaceId,
        kind,
        title,
        tags: tags ?? [],
        conversationId,
        createdBy: db.user.id,
        bodyMd: messages.map((message) => message.content.text).join("\n\n"),
        data: { messageIds },
      });
      db.kbEntries.push(entry);
      publishEntry(db, "kb.entry.created", entry);
      return HttpResponse.json(entry, { status: 201 });
    }),

    // Registered before `/api/kb/:id`, like the real API, so "search" is never read as an id.
    http.get(path("kb.search"), ({ request }) => {
      if (!db.signedIn) return unauthorized();
      const url = new URL(request.url);
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (!q) return apiError(400, "validation_failed", "q: Enter something to search for.");
      const kinds = parseKinds(url);
      if (kinds === null) return apiError(400, "validation_failed", "Unknown entry kind.");
      const limit = Math.min(
        KB_SEARCH_MAX_LIMIT,
        Number(url.searchParams.get("limit") ?? KB_SEARCH_DEFAULT_LIMIT) || KB_SEARCH_DEFAULT_LIMIT,
      );
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      return HttpResponse.json({ items: searchKb(db, { q, workspaceId, kinds, limit }) });
    }),

    http.get(path("kb.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const entry = findEntry(String(params.id));
      return entry ? HttpResponse.json(entry) : notFound();
    }),

    http.patch(path("kb.update"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const entry = findEntry(String(params.id));
      if (!entry) return notFound();
      const parsed = UpdateKbEntrySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const update = parsed.data;
      if (Date.parse(update.expectedUpdatedAt) !== Date.parse(entry.updatedAt)) {
        return apiError(409, "conflict", "This entry changed since you loaded it.");
      }
      const decisionFields = [update.decision, update.rationale, update.status];
      const referenceFields = [
        update.likedReason,
        update.author,
        update.transcript,
        update.mediaAssetId,
      ];
      if (entry.kind !== "decision" && decisionFields.some((value) => value !== undefined)) {
        return apiError(400, "validation_failed", "Only decisions have those fields.");
      }
      if (entry.kind !== "reference" && referenceFields.some((value) => value !== undefined)) {
        return apiError(400, "validation_failed", "Only references have those fields.");
      }
      const updated = updateKbEntry(db, entry.id, (target) => {
        if (update.title !== undefined) target.title = update.title;
        if (update.bodyMd !== undefined) target.bodyMd = update.bodyMd;
        if (update.tags !== undefined) target.tags = update.tags;
        if (target.kind === "decision") {
          const data = { ...(target.data as DecisionData) };
          if (update.decision !== undefined) data.decision = update.decision;
          if (update.rationale !== undefined) {
            if (update.rationale) data.rationale = update.rationale;
            else delete data.rationale;
          }
          if (update.status !== undefined) data.status = update.status;
          target.data = data;
        }
        if (target.reference) {
          if (update.likedReason !== undefined) target.reference.likedReason = update.likedReason;
          if (update.author !== undefined) target.reference.author = update.author;
          if (update.transcript !== undefined) target.reference.transcript = update.transcript;
          if (update.mediaAssetId !== undefined)
            target.reference.mediaAssetId = update.mediaAssetId;
        }
      });
      return HttpResponse.json(updated);
    }),

    http.delete(path("kb.delete"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const entry = findEntry(String(params.id));
      if (!entry) return notFound();
      db.kbEntries = db.kbEntries.filter((item) => item.id !== entry.id);
      publish(db, {
        type: "kb.entry.deleted",
        payload: { entryId: entry.id, workspaceId: entry.workspaceId },
      });
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(path("kb.analyze"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const entry = findEntry(String(params.id));
      if (!entry) return notFound();
      if (!entry.reference) {
        return apiError(400, "validation_failed", "Only references can be analysed.");
      }
      if (!entry.reference.transcript && !entry.reference.mediaAssetId) {
        return apiError(
          409,
          "conflict",
          "Add a transcript or media before analysing this reference.",
        );
      }
      const job = mockJob({
        workspaceId: entry.workspaceId,
        conversationId: null,
        type: "kb.analyze_reference",
      });
      db.jobs.push(job);
      publish(db, { type: "job.updated", payload: { job } });
      updateKbEntry(db, entry.id, (target) => {
        if (!target.reference) return;
        target.reference.analysisStatus = "queued";
        target.reference.analysisJobId = job.id;
      });
      if (db.simulateProducer) runAnalysis(db, entry.id, job.id);
      return HttpResponse.json(job, { status: 201 });
    }),
  ];
}

// Demo content ----------------------------------------------------------------

const DEMO_TRANSCRIPT = [
  "[00:00] This line compiles.",
  "[00:02] Add one more and Rust refuses. Here's why.",
  "[00:05] Every value in Rust has exactly one owner.",
  "[00:09] When I assign title to moved, the String moves.",
  "[00:13] The old name is gone. Using it is error E0382.",
  "[00:18] The fix: borrow it instead.",
  "[00:21] Ampersand title. Now moved only reads it.",
  "[00:27] Run it again.",
  "[00:30] It compiles, and title still works.",
  "[00:41] One owner. Borrow when you only need to read.",
  "[00:47] Follow for one Rust error a day.",
].join("\n");

/** Knowledge for the first demo workspace, so mock mode opens on real entries. */
export function demoKb(workspaceId: string, userId: string, now: number): KbEntryDetail[] {
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const entry = (minutes: number, overrides: Parameters<typeof mockKbEntry>[0]) =>
    mockKbEntry({
      createdBy: userId,
      createdAt: at(minutes),
      updatedAt: at(minutes),
      ...overrides,
    });

  const oldCaptions = entry(9 * 24 * 60, {
    workspaceId,
    kind: "decision",
    title: "Captions sit at the top of the frame",
    tags: ["captions", "style"],
    bodyMd: "Captions sit at the top of the frame.",
    data: { decision: "Captions sit at the top of the frame.", status: "superseded" },
  });
  const captions = entry(2 * 24 * 60, {
    workspaceId,
    kind: "decision",
    title: "Captions sit in the lower third, two lines at most",
    tags: ["captions", "style"],
    bodyMd: "Captions sit in the lower third, two lines at most.",
    data: {
      decision: "Captions sit in the lower third, two lines at most.",
      rationale:
        "Top captions collided with the platform's own overlays on Instagram and YouTube. The lower third stays clear of both.",
      status: "active",
    },
  });
  oldCaptions.data = { ...oldCaptions.data, supersededBy: captions.id };
  oldCaptions.updatedAt = captions.createdAt;

  const instagramUrl = normalizeReferenceUrl(
    "https://www.instagram.com/reel/RustOwnershipDemo/?igsh=share",
  );
  const youtubeUrl = normalizeReferenceUrl("https://youtube.com/shorts/lifetimesDemo?si=share");

  return [
    entry(20, {
      workspaceId,
      kind: "brainstorm",
      title: "Hooks that open on the compiler error",
      tags: ["hooks", "rust-errors"],
      bodyMd: [
        "Open every short on the **error**, not the fix. Ideas:",
        "",
        "- `E0382` borrow of moved value",
        "- `E0499` two mutable borrows",
        "- `E0106` missing lifetime specifier",
        "",
        "> Keep the first frame readable without sound.",
      ].join("\n"),
    }),
    entry(3 * 60, {
      workspaceId,
      kind: "reference",
      title: "Instagram video by @fastrustclips",
      tags: ["hooks", "pacing"],
      bodyMd: "The error is on screen before the first word.",
      sourceUrl: instagramUrl.url,
      reference: mockReferenceDetail({
        url: instagramUrl.url,
        platform: instagramUrl.platform,
        author: "@fastrustclips",
        likedReason:
          "The error is on screen before the first word, and the fix runs live at the end.",
        transcript: DEMO_TRANSCRIPT,
        analysis: DEMO_ANALYSIS,
        analysisStatus: "done",
        analyzedAt: at(2 * 60),
      }),
    }),
    entry(26 * 60, {
      workspaceId,
      kind: "reference",
      title: "YouTube short on lifetimes",
      tags: ["lifetimes"],
      bodyMd: "Draws lifetimes as arrows; worth borrowing the visual.",
      sourceUrl: youtubeUrl.url,
      reference: mockReferenceDetail({
        url: youtubeUrl.url,
        platform: youtubeUrl.platform,
        likedReason: "Draws lifetimes as arrows; worth borrowing the visual.",
        transcript: [
          "[00:00] Lifetimes are just arrows.",
          "[00:03] Each reference points at something that must live longer.",
          "[00:08] When the arrow outlives its target, the compiler stops you.",
        ].join("\n"),
      }),
    }),
    captions,
    entry(3 * 24 * 60, {
      workspaceId,
      kind: "decision",
      title: "Every short ends on code that runs",
      tags: ["format"],
      bodyMd: "Every short ends on code that runs.",
      data: {
        decision: "Every short ends on code that runs.",
        rationale: "Viewers trust the explanation once they see the fix compile.",
        status: "active",
      },
    }),
    oldCaptions,
    entry(4 * 24 * 60, {
      workspaceId,
      kind: "note",
      title: "Recording checklist",
      tags: ["production"],
      bodyMd: [
        "- [x] Editor font at 22 pt",
        "- [x] Hide the minimap and breadcrumbs",
        "- [ ] Record at 1080×1920",
        "- [ ] Leave two seconds of silence at the end",
      ].join("\n"),
    }),
    entry(5 * 24 * 60, {
      workspaceId,
      kind: "session_summary",
      title: "Session: drafted the lifetimes script",
      createdVia: "hook",
      tags: ["lifetimes"],
      bodyMd:
        "Drafted a 55-second script on lifetimes. Open question: whether to show the arrow diagram before or after the error.",
      data: { sessionId: "demo-session" },
    }),
    entry(6 * 24 * 60, {
      workspaceId,
      kind: "brainstorm",
      title: "Ten-episode arc for the ownership series",
      tags: ["series-plan"],
      bodyMd: "1. Moves\n2. Borrows\n3. Mutable borrows\n4. Slices\n5. Lifetimes",
    }),
  ];
}
