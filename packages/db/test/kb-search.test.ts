import {
  KB_ENTRY_KINDS,
  KB_SEARCH_MAX_LIMIT,
  KB_SNIPPET_MATCH_END,
  KB_SNIPPET_MATCH_START,
  KbSearchHitSchema,
  normalizeReferenceUrl,
  parseKbEntryData,
} from "@loomcast/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KB_FIXTURES } from "../src/fixtures/kb";
import { escapeLikePattern, kbSearch, referenceSearchExtra } from "../src/queries/kb-search";
import { kbEntries, kbReferences } from "../src/schema";
import { seedKb } from "../src/seed-dev";
import { createTestDb, type TestDb } from "../src/testing";
import { insertKbEntry, insertUser, insertWorkspace } from "./fixtures";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

/** A fresh workspace, so each test searches only its own entries. */
async function newWorkspace() {
  const user = await insertUser(testDb.db);
  const workspace = await insertWorkspace(testDb.db, user.id);
  return { user, workspaceId: workspace.id };
}

async function titles(q: string, workspaceId: string, options: { kinds?: [] | string[] } = {}) {
  const hits = await kbSearch(testDb.db, {
    q,
    workspaceId,
    kinds: options.kinds as never,
  });
  return hits.map((hit) => hit.title);
}

describe("kbSearch ranking", () => {
  it("ranks a title match above a body match", async () => {
    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, {
      workspaceId,
      title: "Weekly notes",
      bodyMd: "We talked about caching for a while, then about caching again, then lunch.",
    });
    await insertKbEntry(testDb.db, {
      workspaceId,
      title: "Caching strategies",
      bodyMd: "Write-through and write-back compared.",
    });

    const hits = await kbSearch(testDb.db, { q: "caching", workspaceId });
    expect(hits.map((hit) => hit.title)).toEqual(["Caching strategies", "Weekly notes"]);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.POSITIVE_INFINITY);
  });

  it("ranks tags above body text and body text above hidden extra text", async () => {
    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, { workspaceId, title: "Third", searchExtra: "kubernetes" });
    await insertKbEntry(testDb.db, { workspaceId, title: "Second", bodyMd: "kubernetes" });
    await insertKbEntry(testDb.db, { workspaceId, title: "First", tags: ["kubernetes"] });

    expect(await titles("kubernetes", workspaceId)).toEqual(["First", "Second", "Third"]);
  });

  it("finds a title despite a typo", async () => {
    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, {
      workspaceId,
      kind: "brainstorm",
      title: "Brainstorm: hooks for a Rust ownership short",
    });
    await insertKbEntry(testDb.db, { workspaceId, title: "Render checklist" });

    expect(await titles("brainstrom", workspaceId)).toEqual([
      "Brainstorm: hooks for a Rust ownership short",
    ]);
  });

  it("boosts titles that start with the query and matches them by prefix", async () => {
    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, { workspaceId, title: "Notes on the kubectl workflow" });
    await insertKbEntry(testDb.db, { workspaceId, title: "Kubectl cheat sheet" });

    // A partial word: no lexeme matches, the prefix does.
    expect(await titles("kubec", workspaceId)).toContain("Kubectl cheat sheet");
    expect((await titles("kubectl", workspaceId))[0]).toBe("Kubectl cheat sheet");
  });

  it("matches LIKE wildcards in the query literally", async () => {
    expect(escapeLikePattern("50%_off\\")).toBe("50\\%\\_off\\\\");

    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, { workspaceId, title: "a_b testing notes" });
    await insertKbEntry(testDb.db, { workspaceId, title: "axb planning" });

    expect(await titles("a_b", workspaceId)).toEqual(["a_b testing notes"]);
  });
});

describe("kbSearch query syntax", () => {
  it("supports quoted phrases", async () => {
    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, {
      workspaceId,
      title: "Adjacent",
      bodyMd: "Explaining the borrow checker to beginners.",
    });
    await insertKbEntry(testDb.db, {
      workspaceId,
      title: "Scattered",
      bodyMd: "The checker runs after you borrow a value.",
    });

    expect(await titles("borrow checker", workspaceId)).toHaveLength(2);
    expect(await titles('"borrow checker"', workspaceId)).toEqual(["Adjacent"]);
  });

  it("supports -exclude", async () => {
    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, { workspaceId, title: "First", bodyMd: "Rust without unsafe." });
    await insertKbEntry(testDb.db, { workspaceId, title: "Second", bodyMd: "Plain rust code." });

    expect(await titles("rust", workspaceId)).toHaveLength(2);
    expect(await titles("rust -unsafe", workspaceId)).toEqual(["Second"]);
  });

  it("returns nothing for an empty query", async () => {
    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, { workspaceId, title: "Anything" });
    expect(await titles("   ", workspaceId)).toEqual([]);
  });
});

describe("kbSearch filters", () => {
  it("filters by kind", async () => {
    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, { workspaceId, kind: "note", title: "Note", bodyMd: "latency" });
    await insertKbEntry(testDb.db, {
      workspaceId,
      kind: "decision",
      title: "Decision",
      bodyMd: "latency",
    });
    await insertKbEntry(testDb.db, {
      workspaceId,
      kind: "brainstorm",
      title: "Brainstorm",
      bodyMd: "latency",
    });

    expect((await titles("latency", workspaceId)).sort()).toEqual([
      "Brainstorm",
      "Decision",
      "Note",
    ]);
    expect(await titles("latency", workspaceId, { kinds: ["decision"] })).toEqual(["Decision"]);
    expect((await titles("latency", workspaceId, { kinds: ["decision", "note"] })).sort()).toEqual([
      "Decision",
      "Note",
    ]);
    expect(await titles("latency", workspaceId, { kinds: [] })).toEqual([]);
  });

  it("filters by workspace, or searches every workspace without one", async () => {
    const first = await newWorkspace();
    const second = await newWorkspace();
    const word = `marmot${Date.now()}`;
    await insertKbEntry(testDb.db, { workspaceId: first.workspaceId, title: "One", bodyMd: word });
    await insertKbEntry(testDb.db, { workspaceId: second.workspaceId, title: "Two", bodyMd: word });

    expect(await titles(word, first.workspaceId)).toEqual(["One"]);
    const everywhere = await kbSearch(testDb.db, { q: word });
    expect(everywhere.map((hit) => hit.workspaceId).sort()).toEqual(
      [first.workspaceId, second.workspaceId].sort(),
    );
  });

  it("excludes soft-deleted entries", async () => {
    const { workspaceId } = await newWorkspace();
    const deleted = await insertKbEntry(testDb.db, {
      workspaceId,
      title: "Deleted",
      bodyMd: "telemetry",
    });
    await insertKbEntry(testDb.db, { workspaceId, title: "Kept", bodyMd: "telemetry" });
    expect(await titles("telemetry", workspaceId)).toHaveLength(2);

    await testDb.db
      .update(kbEntries)
      .set({ deletedAt: new Date() })
      .where(eq(kbEntries.id, deleted.id));
    expect(await titles("telemetry", workspaceId)).toEqual(["Kept"]);
    // Also when the title itself matches.
    expect(await titles("Deleted", workspaceId)).toEqual([]);
  });

  it("caps the number of hits", async () => {
    const { workspaceId } = await newWorkspace();
    for (let index = 0; index < 4; index += 1) {
      await insertKbEntry(testDb.db, { workspaceId, title: `Entry ${index}`, bodyMd: "gopher" });
    }
    expect(await kbSearch(testDb.db, { q: "gopher", workspaceId, limit: 3 })).toHaveLength(3);
    expect(await kbSearch(testDb.db, { q: "gopher", workspaceId, limit: 0 })).toHaveLength(1);
    expect(
      await kbSearch(testDb.db, { q: "gopher", workspaceId, limit: KB_SEARCH_MAX_LIMIT + 10 }),
    ).toHaveLength(4);
  });
});

describe("kbSearch snippets", () => {
  it("highlights body matches with the contract sentinels and returns valid hits", async () => {
    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, {
      workspaceId,
      title: "Retention",
      bodyMd:
        "Viewers leave at four seconds when the video opens on a title card. Opening on motion " +
        "keeps them past ten seconds.",
    });

    const [hit] = await kbSearch(testDb.db, { q: "motion", workspaceId });
    expect(hit?.snippet).toContain(`${KB_SNIPPET_MATCH_START}motion${KB_SNIPPET_MATCH_END}`);
    expect(KbSearchHitSchema.parse(hit)).toEqual(hit);
  });

  it("falls back to the start of the body when the body has no match", async () => {
    const { workspaceId } = await newWorkspace();
    const body = `Line one\n\n   line two ${"word ".repeat(60)}`;
    await insertKbEntry(testDb.db, { workspaceId, title: "Pangolin facts", bodyMd: body });

    const [hit] = await kbSearch(testDb.db, { q: "pangolin", workspaceId });
    expect(hit?.snippet).toBe(body.replace(/\s+/g, " ").trim().slice(0, 160));
  });

  it("strips sentinel characters stored in the body", async () => {
    const { workspaceId } = await newWorkspace();
    await insertKbEntry(testDb.db, {
      workspaceId,
      title: "Sentinels",
      bodyMd: `a ${KB_SNIPPET_MATCH_START}fake${KB_SNIPPET_MATCH_END} mark near the axolotl`,
    });

    const [hit] = await kbSearch(testDb.db, { q: "axolotl", workspaceId });
    expect(hit?.snippet).not.toContain(`${KB_SNIPPET_MATCH_START}fake`);
    expect(hit?.snippet).toContain(`${KB_SNIPPET_MATCH_START}axolotl${KB_SNIPPET_MATCH_END}`);
  });
});

describe("KB fixtures", () => {
  it("are thirty valid entries covering every kind", () => {
    expect(KB_FIXTURES).toHaveLength(30);
    expect(new Set(KB_FIXTURES.map((fixture) => fixture.key)).size).toBe(30);
    expect(new Set(KB_FIXTURES.map((fixture) => fixture.kind))).toEqual(new Set(KB_ENTRY_KINDS));
    for (const fixture of KB_FIXTURES) {
      expect(parseKbEntryData(fixture.kind, fixture.data).success, fixture.key).toBe(true);
      expect(fixture.reference !== undefined, fixture.key).toBe(fixture.kind === "reference");
      if (fixture.reference !== undefined) {
        expect(normalizeReferenceUrl(fixture.reference.url).platform, fixture.key).not.toBe(
          "other",
        );
      }
    }
  });

  it("seed idempotently and are searchable", async () => {
    const { user, workspaceId } = await newWorkspace();
    expect(await seedKb(testDb.db, workspaceId, user.id)).toBe(30);
    expect(await seedKb(testDb.db, workspaceId, user.id)).toBe(0);

    const references = await testDb.db
      .select({ platform: kbReferences.platform })
      .from(kbReferences)
      .innerJoin(kbEntries, eq(kbEntries.id, kbReferences.entryId))
      .where(eq(kbEntries.workspaceId, workspaceId));
    expect(references).toHaveLength(KB_FIXTURES.filter((f) => f.reference).length);

    const typo = await kbSearch(testDb.db, { q: "brainstrom", workspaceId, kinds: ["brainstorm"] });
    expect(typo.length).toBeGreaterThan(0);
    expect(typo.every((hit) => /brainstorm/i.test(hit.title))).toBe(true);

    // References are found by their transcript through search_extra.
    const [transcriptHit] = await kbSearch(testDb.db, { q: "hash map bucket", workspaceId });
    expect(transcriptHit?.kind).toBe("reference");
  });

  it("build the hidden search text of a reference from its parts", () => {
    expect(referenceSearchExtra({ author: "a", likedReason: " ", transcript: "t" })).toBe("a\nt");
    expect(referenceSearchExtra({})).toBe("");
  });
});
