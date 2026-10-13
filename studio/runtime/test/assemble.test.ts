import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleProject, hookFontSize, localTokens } from "../src/assemble.ts";
import { mountCard } from "../src/card.ts";
import { escapeHtml, escapeRichText, secondsAttr } from "../src/html.ts";
import { resolveStudioRoot } from "../src/paths.ts";
import { loadRegistry } from "../src/registry.ts";
import { StoryboardValidationError } from "../src/storyboard.ts";
import { makeStudio, tempDir } from "./support.ts";

const REAL_STUDIO = resolveStudioRoot();
const INJECTED = '<script>alert("x")</script>';

describe("html helpers", () => {
  it("escapes markup and keeps only balanced <em> in rich text", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    expect(escapeRichText("Why <em>vertical</em> wins")).toBe("Why <em>vertical</em> wins");
    expect(escapeRichText("<em>open")).toBe("&lt;em&gt;open");
    expect(escapeRichText("<em><em>x</em></em>")).toBe(
      "&lt;em&gt;&lt;em&gt;x&lt;/em&gt;&lt;/em&gt;",
    );
    expect(escapeRichText(`<em onclick="x">a</em>`)).toContain("&lt;em onclick=");
    expect(escapeRichText(`<em>${INJECTED}</em>`)).toBe(
      "<em>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</em>",
    );
  });

  it("formats seconds for timing attributes", () => {
    expect(secondsAttr(0)).toBe("0");
    expect(secondsAttr(1500)).toBe("1.5");
    expect(secondsAttr(6033.4)).toBe("6.033");
  });

  it("strips font imports from style tokens", () => {
    const css = localTokens(
      '@import url("https://fonts.example.test/css2?family=A:wght@0,400;0,700&display=swap");\n' +
        "@import 'other.css';\n:root { --bg: #000; }\n",
    );
    expect(css).not.toContain("@import");
    expect(css).toContain(":root { --bg: #000; }");
  });

  it("sizes the hook by its length", () => {
    expect(hookFontSize("Short hook")).toBe(80);
    expect(hookFontSize("x".repeat(200))).toBe(44);
  });
});

describe("mountCard", () => {
  const registry = loadRegistry();

  it("wraps a real library card in a template with escaped slots and prefixed ids", async () => {
    const card = registry.getCard("kallaway.t1.section.ascend");
    if (!card) throw new Error("missing card");
    const mounted = mountCard({
      html: await readFile(card.file, "utf8"),
      compositionId: "lc-f1",
      slots: card.slots,
      values: { kicker: INJECTED, headline: "Why <em>vertical</em> wins" },
    });
    expect(mounted).toMatchObject({ compositionId: "lc-f1", width: 1920, height: 1080 });
    const html = mounted.html;
    expect(html).toContain('<template id="lc-f1-template">');
    expect(html).toContain('data-composition-id="lc-f1"');
    expect(html).toContain('window.__timelines["lc-f1"]');
    expect(html).not.toContain('t1-sec-ascend"');
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain("tokens.css");
    // parse5 re-serialises text nodes: < and > stay escaped, quotes need not be.
    expect(html).toContain('&lt;script&gt;alert("x")&lt;/script&gt;');
    expect(html).not.toContain(INJECTED);
    // The word-per-span headline is rebuilt, keeping the ids the timeline animates.
    expect(html).toContain('<span class="word" id="lc-f1--t1-sec-ascend-w0">Why</span>');
    expect(html).toContain(
      '<span class="word accent" id="lc-f1--t1-sec-ascend-w1">vertical</span>',
    );
    expect(html).toContain('"lc-f1--t1-sec-ascend-w0"');
  });

  it("renames ids in styles, attributes, scripts and selectors", async () => {
    const library = loadRegistry({
      libraryDir: join(await makeStudio(await tempDir(), REAL_STUDIO), "style-library"),
    });
    const card = library.getCard("test-style.t1.section.card");
    if (!card) throw new Error("missing card");
    const { html } = mountCard({
      html: await readFile(card.file, "utf8"),
      compositionId: "lc-a",
      slots: card.slots,
      values: { kicker: "Hi", headline: "Plain", words: "alpha <em>beta</em> gamma" },
    });
    expect(html).toContain("#lc-a {");
    expect(html).toContain("#lc-a #lc-a--t-card-glow { fill: url(#lc-a--t-card-grad); }");
    expect(html).toContain('<linearGradient id="lc-a--t-card-grad">');
    expect(html).toContain('getElementById("lc-a--t-card-glow")');
    expect(html).toContain('[data-composition-id="lc-a"] .kicker');
    expect(html).toContain('const ids = ["lc-a--t-card-w0", "lc-a--t-card-w1"]');
    // A third word continues the id sequence; <em> maps to the card's accent class.
    expect(html).toContain('<span class="word" id="lc-a--t-card-w2">gamma</span>');
    expect(html).toContain('<span class="word accent" id="lc-a--t-card-w1">beta</span>');
    // Image slots keep their placeholder; scripts are wrapped so two cards never share scope.
    expect(html).toContain('<span class="photo">IMG</span>');
    expect(html).toContain("(function () {");
  });

  it("refuses a card without a composition root", () => {
    expect(() =>
      mountCard({ html: "<div>nothing</div>", compositionId: "lc-x", slots: [], values: {} }),
    ).toThrow(/data-composition-id/);
  });
});

describe("assembleProject", () => {
  async function setup() {
    const root = await tempDir();
    const studioRoot = await makeStudio(root, REAL_STUDIO);
    const itemDir = join(root, "item");
    const voicePath = join(root, "voice.mp3");
    await writeFile(voicePath, "fake voice bytes");
    return { studioRoot, itemDir, voicePath };
  }

  const storyboard = {
    styleId: "test-style",
    fps: 30,
    aspect: "9:16",
    frames: [
      {
        id: "intro",
        segmentId: "s1",
        startMs: 0,
        endMs: 4_000,
        cardId: "test-style.t1.section.card",
        slots: { kicker: INJECTED.slice(0, 20), headline: `Hello ${INJECTED}`, words: "one two" },
      },
      {
        id: "full",
        segmentId: "s2",
        startMs: 4_000,
        endMs: 6_000,
        cardId: "test-style.t1.thesis.vertical",
        slots: { title: "Native 9:16" },
      },
    ],
  };

  it("writes the shell, sub-compositions, assets and project files", async () => {
    const { studioRoot, itemDir, voicePath } = await setup();
    const result = await assembleProject({
      itemDir,
      storyboard,
      voicePath,
      voiceDurationMs: 6_000,
      hook: `Hook {{CARDS}} ${INJECTED}`,
      title: "Test & title",
      studioRoot,
      alignment: {
        words: "Every short is vertical now. Here is why.".split(" ").map((text, i) => ({
          text,
          startMs: 100 + i * 400,
          endMs: 400 + i * 400,
        })),
      },
      now: new Date("2026-10-13T00:00:00Z"),
    });

    expect(result.renderDir).toBe(join(itemDir, "render"));
    expect(result.durationMs).toBe(6_000);
    expect(result.frames.map((f) => [f.frameId, f.layout, f.file])).toEqual([
      ["intro", "landscape", "compositions/intro.html"],
      ["full", "vertical", "compositions/full.html"],
    ]);
    expect(result.captions.length).toBeGreaterThan(0);

    const index = await readFile(result.indexPath, "utf8");
    expect(index).toContain('data-composition-id="loomcast-short"');
    expect(index).toContain('data-width="1080"');
    expect(index).toContain('data-height="1920"');
    expect(index).toContain('data-duration="6"');
    expect(index).toContain('src="assets/voice.mp3"');
    expect(index).toContain('src="assets/gsap.min.js"');
    expect(index).toContain('window.__timelines["loomcast-short"]');
    expect(index.match(/\{\{[A-Z_]+\}\}/g)).toEqual(["{{CARDS}}"]);
    // The hook is escaped and placeholder text inside it is never expanded.
    expect(index).toContain("Hook {{CARDS}} &lt;script&gt;");
    expect(index).not.toContain(INJECTED);
    expect(index).toContain("<title>Test &amp; title</title>");
    // Landscape cards fit the 1080-wide card area; 9:16 cards fill the frame.
    expect(index).toMatch(
      /id="lc-intro-host" class="lc-card lc-card--landscape"[\s\S]*?data-composition-src="compositions\/intro.html"[\s\S]*?data-start="0" data-duration="4"[\s\S]*?transform: scale\(0.5625\)/,
    );
    expect(index).toMatch(
      /id="lc-full-host" class="lc-card lc-card--vertical"[\s\S]*?data-start="4" data-duration="2"[\s\S]*?left: 0px; top: 0px; width: 1080px; height: 1920px; transform: scale\(1\)/,
    );
    expect(index).toContain('class="clip lc-caption lc-caption--line"');

    const intro = await readFile(join(result.renderDir, "compositions", "intro.html"), "utf8");
    expect(intro).toContain('Hello &lt;script&gt;alert("x")&lt;/script&gt;');
    expect(intro).not.toContain(INJECTED);

    const assets = join(result.renderDir, "assets");
    expect(await readFile(join(assets, "voice.mp3"), "utf8")).toBe("fake voice bytes");
    expect(await readFile(join(assets, "gsap.min.js"), "utf8")).toContain("gsap");
    expect(await readFile(join(assets, "tokens.css"), "utf8")).not.toContain("@import");
    expect(await readFile(join(assets, "shell.css"), "utf8")).toContain(".lc-caption");

    const hyperframes = JSON.parse(
      await readFile(join(result.renderDir, "hyperframes.json"), "utf8"),
    );
    expect(hyperframes.paths.assets).toBe("assets");
    const meta = JSON.parse(await readFile(join(result.renderDir, "meta.json"), "utf8"));
    expect(meta).toMatchObject({
      id: "loomcast-short",
      name: "Test & title",
      createdAt: "2026-10-13T00:00:00.000Z",
      width: 1080,
      height: 1920,
      fps: 30,
      durationMs: 6_000,
      styleId: "test-style",
    });
  });

  it("writes word-style captions and no captions without an alignment", async () => {
    const { studioRoot, itemDir, voicePath } = await setup();
    const words = [
      { text: "Hello", startMs: 0, endMs: 400 },
      { text: "world", startMs: 450, endMs: 900 },
    ];
    const withWords = await assembleProject({
      itemDir,
      storyboard,
      voicePath,
      voiceDurationMs: 6_000,
      studioRoot,
      alignment: { words },
      captionStyle: "word",
    });
    const index = await readFile(withWords.indexPath, "utf8");
    expect(index).toContain('<span class="lc-caption-word" data-word-start="0.45">world</span>');

    const none = await assembleProject({
      itemDir,
      storyboard,
      voicePath,
      voiceDurationMs: 6_000,
      studioRoot,
    });
    expect(none.captions).toEqual([]);
    expect(await readFile(none.indexPath, "utf8")).not.toContain("lc-caption--");
  });

  it("refuses a storyboard that fails validation or a missing duration", async () => {
    const { studioRoot, itemDir, voicePath } = await setup();
    const bad = { ...storyboard, frames: [{ ...storyboard.frames[0], endMs: 1_000 }] };
    await expect(
      assembleProject({ itemDir, storyboard: bad, voicePath, voiceDurationMs: 6_000, studioRoot }),
    ).rejects.toBeInstanceOf(StoryboardValidationError);
    await expect(
      assembleProject({ itemDir, storyboard, voicePath, voiceDurationMs: 0, studioRoot }),
    ).rejects.toThrow(/voice duration/);
  });
});
