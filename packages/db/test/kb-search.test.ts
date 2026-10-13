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
import { insertKbEntry, insertProject, insertUser } from "./fixtures";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

/** A fresh project, so each test searches only its own entries. */
async function newProject() {
  const user = await insertUser(testDb.db);
  const project = await insertProject(testDb.db, user.id);
  return { user, projectId: project.id };
}

async function titles(q: string, projectId: string, options: { kinds?: [] | string[] } = {}) {
  const hits = await kbSearch(testDb.db, {
    q,
    projectId,
    kinds: options.kinds as never,
  });
  return hits.map((hit) => hit.title);
}

describe("kbSearch ranking", () => {
  it("ranks a title match above a body match", async () => {
    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, {
      projectId,
      title: "Weekly notes",
      bodyMd: "We talked about caching for a while, then about caching again, then lunch.",
    });
    await insertKbEntry(testDb.db, {
      projectId,
      title: "Caching strategies",
      bodyMd: "Write-through and write-back compared.",
    });

    const hits = await kbSearch(testDb.db, { q: "caching", projectId });
    expect(hits.map((hit) => hit.title)).toEqual(["Caching strategies", "Weekly notes"]);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.POSITIVE_INFINITY);
  });

  it("ranks tags above body text and body text above hidden extra text", async () => {
    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, { projectId, title: "Third", searchExtra: "kubernetes" });
    await insertKbEntry(testDb.db, { projectId, title: "Second", bodyMd: "kubernetes" });
    await insertKbEntry(testDb.db, { projectId, title: "First", tags: ["kubernetes"] });

    expect(await titles("kubernetes", projectId)).toEqual(["First", "Second", "Third"]);
  });

  it("finds a title despite a typo", async () => {
    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, {
      projectId,
      kind: "brainstorm",
      title: "Brainstorm: hooks for a Rust ownership short",
    });
    await insertKbEntry(testDb.db, { projectId, title: "Render checklist" });

    expect(await titles("brainstrom", projectId)).toEqual([
      "Brainstorm: hooks for a Rust ownership short",
    ]);
  });

  it("boosts titles that start with the query and matches them by prefix", async () => {
    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, { projectId, title: "Notes on the kubectl workflow" });
    await insertKbEntry(testDb.db, { projectId, title: "Kubectl cheat sheet" });

    // A partial word: no lexeme matches, the prefix does.
    expect(await titles("kubec", projectId)).toContain("Kubectl cheat sheet");
    expect((await titles("kubectl", projectId))[0]).toBe("Kubectl cheat sheet");
  });

  it("matches LIKE wildcards in the query literally", async () => {
    expect(escapeLikePattern("50%_off\\")).toBe("50\\%\\_off\\\\");

    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, { projectId, title: "a_b testing notes" });
    await insertKbEntry(testDb.db, { projectId, title: "axb planning" });

    expect(await titles("a_b", projectId)).toEqual(["a_b testing notes"]);
  });
});

describe("kbSearch query syntax", () => {
  it("supports quoted phrases", async () => {
    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, {
      projectId,
      title: "Adjacent",
      bodyMd: "Explaining the borrow checker to beginners.",
    });
    await insertKbEntry(testDb.db, {
      projectId,
      title: "Scattered",
      bodyMd: "The checker runs after you borrow a value.",
    });

    expect(await titles("borrow checker", projectId)).toHaveLength(2);
    expect(await titles('"borrow checker"', projectId)).toEqual(["Adjacent"]);
  });

  it("supports -exclude", async () => {
    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, { projectId, title: "First", bodyMd: "Rust without unsafe." });
    await insertKbEntry(testDb.db, { projectId, title: "Second", bodyMd: "Plain rust code." });

    expect(await titles("rust", projectId)).toHaveLength(2);
    expect(await titles("rust -unsafe", projectId)).toEqual(["Second"]);
  });

  it("returns nothing for an empty query", async () => {
    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, { projectId, title: "Anything" });
    expect(await titles("   ", projectId)).toEqual([]);
  });
});

describe("kbSearch filters", () => {
  it("filters by kind", async () => {
    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, { projectId, kind: "note", title: "Note", bodyMd: "latency" });
    await insertKbEntry(testDb.db, {
      projectId,
      kind: "decision",
      title: "Decision",
      bodyMd: "latency",
    });
    await insertKbEntry(testDb.db, {
      projectId,
      kind: "brainstorm",
      title: "Brainstorm",
      bodyMd: "latency",
    });

    expect((await titles("latency", projectId)).sort()).toEqual(["Brainstorm", "Decision", "Note"]);
    expect(await titles("latency", projectId, { kinds: ["decision"] })).toEqual(["Decision"]);
    expect((await titles("latency", projectId, { kinds: ["decision", "note"] })).sort()).toEqual([
      "Decision",
      "Note",
    ]);
    expect(await titles("latency", projectId, { kinds: [] })).toEqual([]);
  });

  it("filters by project, or searches every project without one", async () => {
    const first = await newProject();
    const second = await newProject();
    const word = `marmot${Date.now()}`;
    await insertKbEntry(testDb.db, { projectId: first.projectId, title: "One", bodyMd: word });
    await insertKbEntry(testDb.db, { projectId: second.projectId, title: "Two", bodyMd: word });

    expect(await titles(word, first.projectId)).toEqual(["One"]);
    const everywhere = await kbSearch(testDb.db, { q: word });
    expect(everywhere.map((hit) => hit.projectId).sort()).toEqual(
      [first.projectId, second.projectId].sort(),
    );
  });

  it("excludes soft-deleted entries", async () => {
    const { projectId } = await newProject();
    const deleted = await insertKbEntry(testDb.db, {
      projectId,
      title: "Deleted",
      bodyMd: "telemetry",
    });
    await insertKbEntry(testDb.db, { projectId, title: "Kept", bodyMd: "telemetry" });
    expect(await titles("telemetry", projectId)).toHaveLength(2);

    await testDb.db
      .update(kbEntries)
      .set({ deletedAt: new Date() })
      .where(eq(kbEntries.id, deleted.id));
    expect(await titles("telemetry", projectId)).toEqual(["Kept"]);
    // Also when the title itself matches.
    expect(await titles("Deleted", projectId)).toEqual([]);
  });

  it("caps the number of hits", async () => {
    const { projectId } = await newProject();
    for (let index = 0; index < 4; index += 1) {
      await insertKbEntry(testDb.db, { projectId, title: `Entry ${index}`, bodyMd: "gopher" });
    }
    expect(await kbSearch(testDb.db, { q: "gopher", projectId, limit: 3 })).toHaveLength(3);
    expect(await kbSearch(testDb.db, { q: "gopher", projectId, limit: 0 })).toHaveLength(1);
    expect(
      await kbSearch(testDb.db, { q: "gopher", projectId, limit: KB_SEARCH_MAX_LIMIT + 10 }),
    ).toHaveLength(4);
  });
});

describe("kbSearch snippets", () => {
  it("highlights body matches with the contract sentinels and returns valid hits", async () => {
    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, {
      projectId,
      title: "Retention",
      bodyMd:
        "Viewers leave at four seconds when the video opens on a title card. Opening on motion " +
        "keeps them past ten seconds.",
    });

    const [hit] = await kbSearch(testDb.db, { q: "motion", projectId });
    expect(hit?.snippet).toContain(`${KB_SNIPPET_MATCH_START}motion${KB_SNIPPET_MATCH_END}`);
    expect(KbSearchHitSchema.parse(hit)).toEqual(hit);
  });

  it("falls back to the start of the body when the body has no match", async () => {
    const { projectId } = await newProject();
    const body = `Line one\n\n   line two ${"word ".repeat(60)}`;
    await insertKbEntry(testDb.db, { projectId, title: "Pangolin facts", bodyMd: body });

    const [hit] = await kbSearch(testDb.db, { q: "pangolin", projectId });
    expect(hit?.snippet).toBe(body.replace(/\s+/g, " ").trim().slice(0, 160));
  });

  it("strips sentinel characters stored in the body", async () => {
    const { projectId } = await newProject();
    await insertKbEntry(testDb.db, {
      projectId,
      title: "Sentinels",
      bodyMd: `a ${KB_SNIPPET_MATCH_START}fake${KB_SNIPPET_MATCH_END} mark near the axolotl`,
    });

    const [hit] = await kbSearch(testDb.db, { q: "axolotl", projectId });
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
    const { user, projectId } = await newProject();
    expect(await seedKb(testDb.db, projectId, user.id)).toBe(30);
    expect(await seedKb(testDb.db, projectId, user.id)).toBe(0);

    const references = await testDb.db
      .select({ platform: kbReferences.platform })
      .from(kbReferences)
      .innerJoin(kbEntries, eq(kbEntries.id, kbReferences.entryId))
      .where(eq(kbEntries.projectId, projectId));
    expect(references).toHaveLength(KB_FIXTURES.filter((f) => f.reference).length);

    const typo = await kbSearch(testDb.db, { q: "brainstrom", projectId, kinds: ["brainstorm"] });
    expect(typo.length).toBeGreaterThan(0);
    expect(typo.every((hit) => /brainstorm/i.test(hit.title))).toBe(true);

    // References are found by their transcript through search_extra.
    const [transcriptHit] = await kbSearch(testDb.db, { q: "hash map bucket", projectId });
    expect(transcriptHit?.kind).toBe("reference");
  });

  it("build the hidden search text of a reference from its parts", () => {
    expect(referenceSearchExtra({ author: "a", likedReason: " ", transcript: "t" })).toBe("a\nt");
    expect(referenceSearchExtra({})).toBe("");
  });
});
