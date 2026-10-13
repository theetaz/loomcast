import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CARD_ID_RE, SLOT_NAME_RE, SLOT_TEXT_MAX_LENGTH, STYLE_ID_RE } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import { resolveStudioRoot, studioPaths } from "../src/paths.ts";
import { cardCatalogue, loadRegistry } from "../src/registry.ts";
import { makeLibrary, tempDir } from "./support.ts";

describe("the real style library", () => {
  const registry = loadRegistry();
  const cards = registry.styles.flatMap((style) => style.cards);

  it("loads every style and card from registry.json", () => {
    expect(registry.styles.map((style) => style.id)).toEqual(["vox-explainer", "kallaway"]);
    expect(cards.length).toBeGreaterThanOrEqual(400);
    expect(new Set(cards.map((card) => card.id)).size).toBe(cards.length);
  });

  it("points every card at an existing file with ids the contracts accept", () => {
    for (const card of cards) {
      expect(existsSync(card.file), card.file).toBe(true);
      expect(card.id).toMatch(CARD_ID_RE);
      expect(card.styleId).toMatch(STYLE_ID_RE);
      for (const slot of card.slots) expect(slot.name).toMatch(SLOT_NAME_RE);
      expect(card.duration.min).toBeGreaterThan(0);
      expect(card.duration.max).toBeGreaterThanOrEqual(card.duration.min);
    }
  });

  it("joins slot types and limits from style.json", () => {
    const card = registry.getCard("vox-explainer.t1.section.circle");
    expect(card?.slots).toEqual([
      { name: "kicker", type: "text", maxChars: 28 },
      expect.objectContaining({ name: "headline", type: "richtext", maxChars: 70 }),
      expect.objectContaining({ name: "scrap", type: "image" }),
      { name: "source", type: "text", maxChars: 40 },
    ]);
    expect(card?.duration).toEqual({ min: 5, max: 8 });
    // Styles without declared limits fall back to the storyboard contract's cap.
    const kallaway = registry.findCards("kallaway")[0];
    expect(kallaway?.slots.every((slot) => slot.maxChars === SLOT_TEXT_MAX_LENGTH)).toBe(true);
  });

  it("filters cards by tier and purpose and builds a catalogue", () => {
    const stats = registry.findCards("vox-explainer", { tier: "tier1", purpose: "stat" });
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.every((card) => card.tier === "tier1" && card.purpose === "stat")).toBe(true);
    expect(registry.findCards("no-such-style")).toEqual([]);

    const catalogue = cardCatalogue(registry, "kallaway");
    expect(catalogue).toHaveLength(registry.findCards("kallaway").length);
    expect(catalogue[0]).toEqual({
      id: expect.any(String),
      tier: expect.any(String),
      purpose: expect.any(String),
      slots: expect.any(Array),
      durationSec: { min: expect.any(Number), max: expect.any(Number) },
    });
  });

  it("resolves the studio root and its fixed paths", () => {
    const root = resolveStudioRoot();
    expect(existsSync(join(root, "style-library", "registry.json"))).toBe(true);
    const paths = studioPaths(root);
    expect(paths.registry).toBe(join(root, "style-library", "registry.json"));
    expect(existsSync(join(paths.shellTemplate, "index.html"))).toBe(true);
  });
});

describe("a custom style library", () => {
  it("loads a library from a directory", async () => {
    const library = await makeLibrary(await tempDir());
    const registry = loadRegistry({ libraryDir: library });
    expect(registry.getStyle("test-style")?.tokens).toBe(
      join(library, "01-test-style", "tokens.css"),
    );
    expect(registry.getCard("test-style.t1.thesis.vertical")?.slots).toEqual([
      { name: "title", type: "text", maxChars: SLOT_TEXT_MAX_LENGTH },
    ]);
  });

  it("refuses card paths that leave the library", async () => {
    const root = await tempDir();
    const library = join(root, "lib");
    await mkdir(join(library, "01-x"), { recursive: true });
    await writeFile(
      join(library, "registry.json"),
      JSON.stringify({
        styles: [
          {
            id: "x",
            name: "X",
            folder: "01-x",
            cards: [
              {
                id: "x.t1.a",
                style: "x",
                tier: "tier1",
                purpose: "section",
                file: "../../outside/card.html",
                slots: [],
                duration: { min: 1, max: 2 },
              },
            ],
          },
        ],
      }),
    );
    expect(() => loadRegistry({ libraryDir: library })).toThrow(/escapes the style library/);
  });

  it("rejects a malformed registry", async () => {
    const root = await tempDir();
    await writeFile(join(root, "registry.json"), JSON.stringify({ styles: [{ id: 1 }] }));
    expect(() => loadRegistry({ libraryDir: root })).toThrow();
  });
});
