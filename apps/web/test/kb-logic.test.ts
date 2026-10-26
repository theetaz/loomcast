import {
  type JobSummary,
  type KbEntry,
  type KbReferenceDetail,
  MAX_TRANSCRIPT_LENGTH,
} from "@loomcast/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { analysisState } from "@/features/kb/analysis-status";
import { findParts, matchCount } from "@/features/kb/find";
import { kbKeys, matchesFilter, removeKbEntry, upsertKbEntry } from "@/features/kb/queries";
import { parseTag } from "@/features/kb/TagsInput";
import { changedFields, sameContent } from "@/features/kb/TextEntryEditor";
import {
  cleanCueText,
  formatTimestamp,
  parseSrt,
  parseTimecode,
  parseTranscriptFile,
  parseVtt,
  parseWordListJson,
  sanitizeTranscript,
} from "@/features/kb/transcript";
import { mockJob } from "@/mocks/conversations";
import { mockId } from "@/mocks/db";
import { listedEntry, mockKbEntry, mockReferenceDetail } from "@/mocks/kb";

describe("transcript parsing", () => {
  it("formats positions as [mm:ss], counting minutes past the hour", () => {
    expect(formatTimestamp(0)).toBe("[00:00]");
    expect(formatTimestamp(65_400)).toBe("[01:05]");
    expect(formatTimestamp(75 * 60_000 + 3_000)).toBe("[75:03]");
    expect(formatTimestamp(-5)).toBe("[00:00]");
  });

  it("reads SRT and VTT timecodes", () => {
    expect(parseTimecode("00:01:02,500")).toBe(62_500);
    expect(parseTimecode("01:00:00.000")).toBe(3_600_000);
    expect(parseTimecode("02:03.5")).toBe(123_500);
    expect(parseTimecode("not a time")).toBeNull();
  });

  it("parses SRT cues into one line each, without markup", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:02,000",
      "<i>This line</i> compiles.",
      "",
      "2",
      "00:00:02,500 --> 00:00:05,000",
      "{\\an8}Add one more",
      "and Rust refuses &amp; explains.",
      "",
      "3",
      "00:01:10,000 --> 00:01:12,000",
      "",
      "",
    ].join("\r\n");
    expect(parseSrt(srt)).toEqual([
      "[00:00] This line compiles.",
      "[00:02] Add one more and Rust refuses & explains.",
    ]);
  });

  it("parses VTT, skipping the header and NOTE blocks and rolled-up repeats", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "",
      "NOTE written by hand",
      "",
      "intro",
      "00:00.000 --> 00:02.000 align:start",
      "<v Ana>Every value</v> has one owner",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "Every value has one owner",
      "<00:00:03.000><c>Borrow</c> to read it",
      "",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([
      "[00:00] Every value has one owner",
      "[00:02] Borrow to read it",
    ]);
  });

  it("groups a JSON word list into timed lines", () => {
    const words = [
      { word: "Every", start: 0.2 },
      { word: "value", start: 0.5 },
      { word: "has", start: 0.8 },
      { word: "one", start: 1.0 },
      { word: "owner.", start: 1.2 },
      { word: "Borrow", start: 64.1 },
      { word: "it.", start: 64.6 },
    ];
    expect(parseWordListJson(words)).toEqual([
      "[00:00] Every value has one owner.",
      "[01:04] Borrow it.",
    ]);
    expect(parseWordListJson({ words: [{ text: "Hi", startMs: 3_000 }] })).toEqual(["[00:03] Hi"]);
    expect(
      parseWordListJson({
        segments: [
          { start: 0, text: " Lifetimes are arrows." },
          { start: 3.4, text: "Each one points somewhere." },
        ],
      }),
    ).toEqual(["[00:00] Lifetimes are arrows.", "[00:03] Each one points somewhere."]);
    expect(parseWordListJson({ nothing: true })).toEqual([]);
  });

  it("picks the parser from the file extension and reports problems", () => {
    expect(parseTranscriptFile("clip.SRT", "1\n00:00:01,000 --> 00:00:02,000\nHello\n")).toEqual({
      ok: true,
      text: "[00:01] Hello",
      lines: 1,
    });
    expect(parseTranscriptFile("notes.txt", "  one  \r\n\r\n\r\n\r\ntwo ")).toEqual({
      ok: true,
      text: "one\n\ntwo",
      lines: 3,
    });
    expect(parseTranscriptFile("words.json", "{oops")).toEqual({
      ok: false,
      error: "words.json is not valid JSON.",
    });
    expect(parseTranscriptFile("clip.mp4", "x")).toMatchObject({ ok: false });
    expect(parseTranscriptFile("empty.vtt", "WEBVTT\n\n")).toEqual({
      ok: false,
      error: "No transcript text was found in empty.vtt.",
    });
    const long = parseTranscriptFile("long.txt", "a".repeat(MAX_TRANSCRIPT_LENGTH + 1));
    expect(long).toMatchObject({ ok: false, error: expect.stringContaining("200,000") });
  });

  it("drops control characters and lone surrogates the API rejects", () => {
    const bell = String.fromCharCode(7);
    const lone = String.fromCharCode(0xd800);
    expect(sanitizeTranscript(`a${bell}b\tc\nd${lone}e 😀`)).toBe("ab\tc\nde 😀");
    expect(cleanCueText("<b>bold</b> &lt;tag&gt;")).toBe("bold <tag>");
  });
});

function reference(overrides: Partial<KbReferenceDetail> = {}): KbReferenceDetail {
  return mockReferenceDetail({
    url: "https://example.com/v",
    platform: "other",
    transcript: "[00:00] Hello",
    ...overrides,
  });
}

function job(id: string, status: JobSummary["status"], message?: string): JobSummary {
  return mockJob({
    id,
    workspaceId: mockId(),
    conversationId: null,
    type: "kb.analyze_reference",
    status,
    ...(message ? { error: { code: "internal", message, retryable: true } } : {}),
  });
}

describe("analysis status", () => {
  it("offers Analyze before the first run and needs a transcript", () => {
    expect(analysisState(reference(), undefined)).toMatchObject({
      status: null,
      label: "Not analyzed",
      busy: false,
      action: "Analyze",
      canAnalyze: true,
      hint: null,
    });
    expect(analysisState(reference({ transcript: "  " }), undefined)).toMatchObject({
      canAnalyze: false,
      hint: "Add a transcript or upload the media to analyze this reference.",
    });
  });

  it("maps the stored status when no job snapshot is loaded", () => {
    const id = mockId();
    expect(
      analysisState(reference({ analysisStatus: "queued", analysisJobId: id }), undefined),
    ).toMatchObject({ status: "queued", label: "Queued", busy: true, canAnalyze: false });
    expect(
      analysisState(reference({ analysisStatus: "running", analysisJobId: id }), undefined),
    ).toMatchObject({ status: "running", label: "Analyzing", busy: true });
    expect(
      analysisState(reference({ analysisStatus: "done", analysisJobId: id }), undefined),
    ).toMatchObject({ status: "succeeded", label: "Analyzed", action: "Re-analyze" });
    expect(
      analysisState(reference({ analysisStatus: "failed", analysisJobId: id }), undefined),
    ).toMatchObject({ status: "failed", label: "Failed", action: "Re-analyze", canAnalyze: true });
  });

  it("follows job.updated when it is further along than the stored status", () => {
    const id = mockId();
    const stored = reference({ analysisStatus: "queued", analysisJobId: id });
    expect(analysisState(stored, job(id, "dispatched"))).toMatchObject({
      status: "dispatched",
      label: "Starting",
      busy: true,
    });
    expect(analysisState(stored, job(id, "running")).label).toBe("Analyzing");
    expect(analysisState(stored, job(id, "failed", "Producer runtime is offline."))).toMatchObject({
      status: "failed",
      hint: "Producer runtime is offline.",
      busy: false,
    });
  });

  it("ignores stale or unrelated job snapshots", () => {
    const id = mockId();
    const done = reference({ analysisStatus: "done", analysisJobId: id });
    // A cached snapshot from before the analysis finished never moves the pill back.
    expect(analysisState(done, job(id, "running")).status).toBe("succeeded");
    // A job for an earlier run is not this reference's latest job.
    expect(analysisState(done, job(mockId(), "failed")).status).toBe("succeeded");
  });
});

describe("find in transcript", () => {
  it("splits around case-insensitive matches and counts them", () => {
    const parts = findParts("Title, title and TITLE", "title");
    expect(parts).toEqual([
      { text: "Title", match: 0 },
      { text: ", ", match: null },
      { text: "title", match: 1 },
      { text: " and ", match: null },
      { text: "TITLE", match: 2 },
    ]);
    expect(matchCount(parts)).toBe(3);
    expect(findParts("a.b", ".")).toEqual([
      { text: "a", match: null },
      { text: ".", match: 0 },
      { text: "b", match: null },
    ]);
    expect(matchCount(findParts("abc", ""))).toBe(0);
  });
});

describe("tags and editor helpers", () => {
  it("normalises typed tags and rejects invalid ones", () => {
    expect(parseTag("  #Rust Errors ")).toEqual({ tag: "rust-errors" });
    expect(parseTag("-leading")).toMatchObject({ error: expect.any(String) });
    expect(parseTag("x".repeat(41))).toMatchObject({ error: expect.any(String) });
  });

  it("sends only the fields that changed", () => {
    const base = {
      title: "Hooks",
      tags: ["a"],
      bodyMd: "Body",
      updatedAt: "2026-10-13T09:00:00.000Z",
    };
    expect(changedFields({ title: " Hooks ", tags: ["a"], bodyMd: "Body" }, base)).toEqual({});
    expect(changedFields({ title: "New", tags: ["a", "b"], bodyMd: "Body" }, base)).toEqual({
      title: "New",
      tags: ["a", "b"],
    });
    expect(
      sameContent({ title: "x", tags: ["a"], bodyMd: "" }, { title: "x", tags: ["a"], bodyMd: "" }),
    ).toBe(true);
  });
});

describe("knowledge cache patching", () => {
  const workspaceId = mockId();
  const entry = (overrides: Partial<KbEntry> = {}) =>
    listedEntry(mockKbEntry({ workspaceId, kind: "note", title: "Note", ...overrides }));

  function seed(
    client: QueryClient,
    filter: { kind: "all" | "note" | "decision"; tag: string | null },
    items: KbEntry[],
  ) {
    client.setQueryData(kbKeys.list(workspaceId, filter), {
      pages: [{ items, nextCursor: null }],
      pageParams: [undefined],
    });
  }
  const items = (
    client: QueryClient,
    filter: { kind: "all" | "note" | "decision"; tag: string | null },
  ) =>
    (
      client.getQueryData(kbKeys.list(workspaceId, filter)) as { pages: { items: KbEntry[] }[] }
    ).pages[0]?.items.map((item) => item.title);

  it("matches entries against kind and tag filters", () => {
    expect(matchesFilter(entry(), { kind: "all", tag: null })).toBe(true);
    expect(matchesFilter(entry(), { kind: "decision", tag: null })).toBe(false);
    expect(matchesFilter(entry({ tags: ["x"] }), { kind: "note", tag: "x" })).toBe(true);
    expect(matchesFilter(entry(), { kind: "note", tag: "x" })).toBe(false);
  });

  it("adds, replaces, drops and removes entries in every loaded list", () => {
    const client = new QueryClient();
    const first = entry({ title: "First", tags: ["x"] });
    seed(client, { kind: "all", tag: null }, [first]);
    seed(client, { kind: "note", tag: "x" }, [first]);
    seed(client, { kind: "decision", tag: null }, []);

    const created = entry({ title: "Created" });
    upsertKbEntry(client, created);
    expect(items(client, { kind: "all", tag: null })).toEqual(["Created", "First"]);
    expect(items(client, { kind: "note", tag: "x" })).toEqual(["First"]);
    expect(items(client, { kind: "decision", tag: null })).toEqual([]);

    // Losing the tag drops it from the tagged list but keeps it in place elsewhere.
    upsertKbEntry(client, { ...first, title: "First, renamed", tags: [] });
    expect(items(client, { kind: "all", tag: null })).toEqual(["Created", "First, renamed"]);
    expect(items(client, { kind: "note", tag: "x" })).toEqual([]);

    removeKbEntry(client, created.id, workspaceId);
    expect(items(client, { kind: "all", tag: null })).toEqual(["First, renamed"]);
  });
});
