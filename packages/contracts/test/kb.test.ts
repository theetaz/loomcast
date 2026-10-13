import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildPath,
  CaptureConversationSchema,
  CreateKbEntrySchema,
  InspectPasswordTokenRequestSchema,
  InviteUserRequestSchema,
  InviteUserResponseSchema,
  isPlainText,
  type JobType,
  KB_MAX_TAGS,
  KB_SNIPPET_MATCH_END,
  KB_SNIPPET_MATCH_START,
  KbEntryDetailSchema,
  KbSearchHitSchema,
  KbSearchQuerySchema,
  KbTagsSchema,
  ListKbQuerySchema,
  MAX_TRANSCRIPT_LENGTH,
  PASSWORD_TOKEN_TTL_MS,
  PasswordTokenInfoSchema,
  parseKbEntryData,
  type RouteBody,
  type RouteQuery,
  type RouteResponse,
  routes,
  SetPasswordRequestSchema,
  splitKbSnippet,
  TranscriptSchema,
  UpdateKbEntrySchema,
  UserSummarySchema,
} from "../src";
import { analysis, at, fakeSecret, ids, kbEntry } from "./fixtures";

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("knowledge-base tags", () => {
  it("trims and lowercases tags", () => {
    expect(KbTagsSchema.parse([" Rust ", "HOOKS", "short-form", "2026"])).toEqual([
      "rust",
      "hooks",
      "short-form",
      "2026",
    ]);
  });

  it.each([["-leading"], ["under_score"], ["two words"], [""], ["x".repeat(41)], ["émoji"]])(
    "rejects the tag %j",
    (tag) => {
      expect(ok(KbTagsSchema, [tag])).toBe(false);
    },
  );

  it("accepts 40-character tags and at most 20 distinct tags", () => {
    const tags = Array.from({ length: KB_MAX_TAGS }, (_, index) => `tag-${index}`);

    expect(ok(KbTagsSchema, ["x".repeat(40)])).toBe(true);
    expect(ok(KbTagsSchema, tags)).toBe(true);
    expect(ok(KbTagsSchema, [...tags, "one-more"])).toBe(false);
    expect(ok(KbTagsSchema, ["rust", "Rust"])).toBe(false);
  });
});

describe("transcripts", () => {
  it("accepts text up to 200,000 characters with line breaks, tabs and emoji", () => {
    expect(ok(TranscriptSchema, "x".repeat(MAX_TRANSCRIPT_LENGTH))).toBe(true);
    expect(ok(TranscriptSchema, "line one\r\nline\ttwo 😀")).toBe(true);
  });

  it("rejects empty, over-long and control-character transcripts", () => {
    expect(ok(TranscriptSchema, "x".repeat(MAX_TRANSCRIPT_LENGTH + 1))).toBe(false);
    expect(ok(TranscriptSchema, " \n ")).toBe(false);
    expect(ok(TranscriptSchema, "bell\u0007")).toBe(false);
    expect(ok(TranscriptSchema, `match${KB_SNIPPET_MATCH_START}`)).toBe(false);
  });

  it.each([
    ["plain text", "hello", true],
    ["a surrogate pair", "😀", true],
    ["a lone high surrogate", "a\ud800b", false],
    ["a trailing high surrogate", "a\ud800", false],
    ["a lone low surrogate", "\udc00", false],
    ["a null character", "\u0000", false],
    ["DEL", "\u007f", true],
  ])("isPlainText on %s is %s", (_name, text, expected) => {
    expect(isPlainText(text)).toBe(expected);
  });
});

describe("CreateKbEntry", () => {
  it("accepts each kind with its own fields", () => {
    const entries = [
      { kind: "brainstorm", title: "Hooks", bodyMd: "- one\n- two", tags: ["hooks"] },
      { kind: "note", title: "Gear", bodyMd: "" },
      {
        kind: "decision",
        title: "Format",
        decision: "Vertical only",
        rationale: "Every channel is vertical",
        supersedes: ids.entry,
      },
      {
        kind: "reference",
        url: "https://www.instagram.com/reel/abc/?igsh=1",
        likedReason: "The cold open",
        author: "@dev",
        transcript: "Stop scrolling.",
      },
    ];

    for (const entry of entries) {
      expect(CreateKbEntrySchema.parse(entry)).toEqual(entry);
    }
  });

  it("rejects session summaries, unknown kinds and fields of another kind", () => {
    expect(ok(CreateKbEntrySchema, { kind: "session_summary", title: "t", bodyMd: "b" })).toBe(
      false,
    );
    expect(ok(CreateKbEntrySchema, { kind: "decision", title: "t", bodyMd: "b" })).toBe(false);
    expect(ok(CreateKbEntrySchema, { kind: "reference", title: "t", bodyMd: "b" })).toBe(false);
  });

  it("validates reference links without fetching them", () => {
    const reference = (url: string) => ok(CreateKbEntrySchema, { kind: "reference", url });

    expect(reference("youtu.be/abc")).toBe(true);
    expect(reference("javascript:alert(1)")).toBe(false);
    expect(reference("not a link")).toBe(false);
  });

  it("caps titles and transcripts", () => {
    expect(ok(CreateKbEntrySchema, { kind: "note", title: "x".repeat(201), bodyMd: "" })).toBe(
      false,
    );
    expect(ok(CreateKbEntrySchema, { kind: "note", title: "   ", bodyMd: "" })).toBe(false);
    expect(
      ok(CreateKbEntrySchema, {
        kind: "reference",
        url: "https://youtu.be/a",
        transcript: "x".repeat(MAX_TRANSCRIPT_LENGTH + 1),
      }),
    ).toBe(false);
  });
});

describe("UpdateKbEntry", () => {
  it("requires expectedUpdatedAt and at least one change", () => {
    expect(ok(UpdateKbEntrySchema, { title: "New" })).toBe(false);
    expect(ok(UpdateKbEntrySchema, { expectedUpdatedAt: at })).toBe(false);
    expect(ok(UpdateKbEntrySchema, { expectedUpdatedAt: "yesterday", title: "New" })).toBe(false);
    expect(UpdateKbEntrySchema.parse({ expectedUpdatedAt: at, title: " New " })).toEqual({
      expectedUpdatedAt: at,
      title: "New",
    });
  });

  it("clears nullable fields with null", () => {
    expect(ok(UpdateKbEntrySchema, { expectedUpdatedAt: at, rationale: null })).toBe(true);
    expect(ok(UpdateKbEntrySchema, { expectedUpdatedAt: at, transcript: null })).toBe(true);
    expect(ok(UpdateKbEntrySchema, { expectedUpdatedAt: at, status: "superseded" })).toBe(true);
    expect(ok(UpdateKbEntrySchema, { expectedUpdatedAt: at, status: "archived" })).toBe(false);
  });
});

describe("entry data", () => {
  it("validates data per kind", () => {
    expect(parseKbEntryData("decision", kbEntry.data).success).toBe(true);
    expect(parseKbEntryData("decision", { decision: "x" }).success).toBe(false);
    expect(parseKbEntryData("session_summary", { sessionId: "s1", cwd: "/tmp" }).success).toBe(
      true,
    );
    expect(parseKbEntryData("brainstorm", { messageIds: [ids.message] }).success).toBe(true);
    expect(parseKbEntryData("note", { messageIds: ["1"] }).success).toBe(false);

    const decision = parseKbEntryData("decision", kbEntry.data);
    if (decision.success) {
      expectTypeOf(decision.data.status).toEqualTypeOf<"active" | "superseded">();
    }
  });

  it("parses an entry with and without reference details", () => {
    const reference = {
      ...kbEntry,
      kind: "reference",
      data: {},
      sourceUrl: "https://instagram.com/reel/abc/",
      reference: {
        url: "https://instagram.com/reel/abc/",
        platform: "instagram",
        author: null,
        likedReason: "The cold open",
        transcript: "Stop scrolling.",
        analysis,
        analysisStatus: "done",
        analysisJobId: ids.job,
        analyzedAt: at,
      },
    };

    expect(KbEntryDetailSchema.parse(reference)).toEqual(reference);
    expect(ok(KbEntryDetailSchema, { ...kbEntry, reference: null })).toBe(true);
    expect(
      ok(KbEntryDetailSchema, {
        ...reference,
        reference: { ...reference.reference, analysisStatus: "pending" },
      }),
    ).toBe(false);
  });
});

describe("listing and search queries", () => {
  it("splits comma-separated kinds and coerces the limit", () => {
    expect(ListKbQuerySchema.parse({ kinds: "brainstorm, decision", limit: "10" })).toEqual({
      kinds: ["brainstorm", "decision"],
      limit: 10,
    });
    expect(ListKbQuerySchema.parse({ kinds: ["note"], tag: "Rust" })).toEqual({
      kinds: ["note"],
      tag: "rust",
    });
    expect(ok(ListKbQuerySchema, { kinds: "brainstorm,video" })).toBe(false);
    expect(ok(ListKbQuerySchema, { kinds: "" })).toBe(false);
  });

  it("bounds the search query and limit", () => {
    expect(KbSearchQuerySchema.parse({ q: " hooks ", limit: "50" })).toEqual({
      q: "hooks",
      limit: 50,
    });
    expect(ok(KbSearchQuerySchema, { q: "" })).toBe(false);
    expect(ok(KbSearchQuerySchema, { q: "x".repeat(201) })).toBe(false);
    expect(ok(KbSearchQuerySchema, { q: "x", limit: "51" })).toBe(false);
    expect(ok(KbSearchQuerySchema, { q: "x", projectId: "rust" })).toBe(false);
  });

  it("parses search hits", () => {
    const hit = {
      entryId: ids.entry,
      projectId: ids.project,
      kind: "brainstorm",
      title: "Hooks",
      snippet: `three ${KB_SNIPPET_MATCH_START}hooks${KB_SNIPPET_MATCH_END} about ownership`,
      score: 0.42,
    };

    expect(KbSearchHitSchema.parse(hit)).toEqual(hit);
    expect(ok(KbSearchHitSchema, { ...hit, score: -1 })).toBe(false);
  });
});

describe("splitKbSnippet", () => {
  it("splits matches out of a snippet", () => {
    const snippet = `a ${KB_SNIPPET_MATCH_START}b${KB_SNIPPET_MATCH_END} c ${KB_SNIPPET_MATCH_START}d${KB_SNIPPET_MATCH_END}`;

    expect(splitKbSnippet(snippet)).toEqual([
      { text: "a ", match: false },
      { text: "b", match: true },
      { text: " c ", match: false },
      { text: "d", match: true },
    ]);
  });

  it("treats markup as text and tolerates unbalanced sentinels", () => {
    expect(splitKbSnippet("<b>x</b>")).toEqual([{ text: "<b>x</b>", match: false }]);
    expect(splitKbSnippet(`${KB_SNIPPET_MATCH_END}a${KB_SNIPPET_MATCH_START}b`)).toEqual([
      { text: "a", match: false },
      { text: "b", match: true },
    ]);
    expect(splitKbSnippet("")).toEqual([]);
  });
});

describe("CaptureConversation", () => {
  const capture = {
    conversationId: ids.conversation,
    messageIds: [ids.message],
    title: "Hook ideas",
    kind: "brainstorm",
  };

  it("captures 1 to 200 distinct messages as a brainstorm or note", () => {
    const many = Array.from(
      { length: 200 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    );

    expect(CaptureConversationSchema.parse(capture)).toEqual(capture);
    expect(ok(CaptureConversationSchema, { ...capture, messageIds: many })).toBe(true);
    expect(
      ok(CaptureConversationSchema, {
        ...capture,
        messageIds: [...many, "00000000-0000-4000-8000-999999999999"],
      }),
    ).toBe(false);
    expect(ok(CaptureConversationSchema, { ...capture, messageIds: [] })).toBe(false);
    expect(
      ok(CaptureConversationSchema, { ...capture, messageIds: [ids.message, ids.message] }),
    ).toBe(false);
    expect(ok(CaptureConversationSchema, { ...capture, kind: "decision" })).toBe(false);
  });
});

describe("user and set-password DTOs", () => {
  const token = "A".repeat(43);
  const user = {
    id: ids.user,
    email: "editor@example.test",
    name: "Editor",
    role: "admin",
    createdAt: at,
    lastLoginAt: null,
    disabledAt: null,
  };

  it("normalises an invitation", () => {
    expect(
      InviteUserRequestSchema.parse({
        email: " Editor@Example.TEST",
        name: " Editor ",
        role: "admin",
      }),
    ).toEqual({ email: "editor@example.test", name: "Editor", role: "admin" });
    expect(ok(InviteUserRequestSchema, { email: "editor", name: "E", role: "admin" })).toBe(false);
    expect(ok(InviteUserRequestSchema, { email: "e@x.test", name: "E", role: "viewer" })).toBe(
      false,
    );
  });

  it("returns a link and never a password", () => {
    const response = {
      user,
      setPasswordUrl: `https://loomcast.example.test/set-password#${token}`,
      expiresAt: at,
    };

    expect(
      InviteUserResponseSchema.parse({ ...response, password: fakeSecret("password") }),
    ).toEqual(response);
    expect(UserSummarySchema.parse(user)).toEqual(user);
  });

  it("checks the token format and the new password", () => {
    expect(ok(InspectPasswordTokenRequestSchema, { token })).toBe(true);
    expect(ok(InspectPasswordTokenRequestSchema, { token: "short" })).toBe(false);
    expect(ok(InspectPasswordTokenRequestSchema, { token: `${token}/../x` })).toBe(false);
    expect(ok(SetPasswordRequestSchema, { token, newPassword: fakeSecret("new") })).toBe(true);
    expect(ok(SetPasswordRequestSchema, { token, newPassword: "short" })).toBe(false);
    expect(
      PasswordTokenInfoSchema.parse({ email: user.email, purpose: "invite", expiresAt: at }),
    ).toEqual({ email: user.email, purpose: "invite", expiresAt: at });
    expect(PASSWORD_TOKEN_TTL_MS.reset).toBeLessThan(PASSWORD_TOKEN_TTL_MS.invite);
  });
});

describe("knowledge-base and user routes", () => {
  it("builds the knowledge-base paths", () => {
    expect(buildPath(routes["kb.list"].path, { projectId: ids.project })).toBe(
      `/api/projects/${ids.project}/kb`,
    );
    expect(buildPath(routes["kb.analyze"].path, { id: ids.entry })).toBe(
      `/api/kb/${ids.entry}/analyze`,
    );
    expect(routes["kb.search"].path).toBe("/api/kb/search");
    expect(routes["kb.delete"].status).toBe(204);
    expect(routes["users.invite"].path).toBe("/api/users/invitations");
  });

  it("derives knowledge-base request and response types", () => {
    expectTypeOf<RouteBody<"kb.update">["expectedUpdatedAt"]>().toEqualTypeOf<string>();
    expectTypeOf<RouteResponse<"kb.analyze">["type"]>().toEqualTypeOf<JobType>();
    expectTypeOf<RouteResponse<"kb.list">["nextCursor"]>().toEqualTypeOf<string | null>();
    expectTypeOf<RouteQuery<"kb.search">["q"]>().toEqualTypeOf<string>();
    expectTypeOf<RouteResponse<"auth.setPassword">>().toEqualTypeOf<undefined>();
  });
});
