import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type Root } from "postcss";
import { describe, expect, it } from "vitest";

// The brand kit is the source of truth. tokens.css copies its `.lc-light` and
// `.lc-dark` custom properties under an `lc-` prefix; this test fails on drift.
const brandHtml = readFileSync(
  join(import.meta.dirname, "../../../design/brand/loomcast-brand.html"),
  "utf8",
);
const tokensCss = readFileSync(join(import.meta.dirname, "../src/styles/tokens.css"), "utf8");

function brandStylesheet(): Root {
  const style = brandHtml.match(/<style>([\s\S]*?)<\/style>/);
  if (!style?.[1]) throw new Error("No <style> block in loomcast-brand.html");
  return postcss.parse(style[1]);
}

/** Declarations from every rule whose selector list contains `selector`, later rules winning. */
function declarationsFor(root: Root, selector: string): Map<string, string> {
  const result = new Map<string, string>();
  root.walkRules((rule) => {
    if (rule.parent?.type !== "root") return;
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    rule.walkDecls((decl) => {
      result.set(decl.prop, decl.value);
    });
  });
  return result;
}

/** Compares values, not formatting: case, spacing and leading zeros are ignored. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/var\(--lc-/g, "var(--")
    .replace(/\s+/g, "")
    .replace(/(^|[^\d.])0\.(\d)/g, "$1.$2");
}

/** Custom properties keyed without the `lc-` prefix, plus `color-scheme`. */
function tokens(declarations: Map<string, string>, prefix: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [prop, value] of declarations) {
    if (prop === "color-scheme") result[prop] = normalize(value);
    else if (prop.startsWith(prefix)) result[`--${prop.slice(prefix.length)}`] = normalize(value);
  }
  return result;
}

const brand = brandStylesheet();
const ours = postcss.parse(tokensCss);

describe("tokens.css matches the brand kit", () => {
  it("has the light tokens on :root", () => {
    const expected = tokens(declarationsFor(brand, ".lc-light"), "--");
    const actual = tokens(declarationsFor(ours, ":root"), "--lc-");
    for (const name of ["--ease", "--ease-io", "--ease-sheet"]) delete actual[name];
    expect(Object.keys(expected).length).toBeGreaterThan(20);
    expect(actual).toEqual(expected);
  });

  it("has the dark tokens on .dark", () => {
    const expected = tokens(declarationsFor(brand, ".lc-dark"), "--");
    const actual = tokens(declarationsFor(ours, ".dark"), "--lc-");
    expect(Object.keys(expected).length).toBeGreaterThan(20);
    expect(actual).toEqual(expected);
  });

  it("covers every surface, text, status and shadow token", () => {
    const light = tokens(declarationsFor(ours, ":root"), "--lc-");
    const required = [
      "bg",
      "side",
      "surface",
      "surface-2",
      "surface-3",
      "border",
      "border-strong",
      "divider",
      "text",
      "text-2",
      "text-3",
      "text-4",
      "accent",
      "on-accent",
      "ember",
      "green",
      "amber",
      "red",
      "blue",
      "violet",
      "gray",
      "shadow-card",
      "shadow-pop",
      "accent-soft",
      "accent-line",
    ];
    for (const name of required) expect(light).toHaveProperty(`--${name}`);
  });

  it("uses the brand easing curves", () => {
    const expected = declarationsFor(brand, ":root");
    const actual = declarationsFor(ours, ":root");
    for (const name of ["--lc-ease", "--lc-ease-io"]) {
      expect(normalize(actual.get(name) ?? "")).toBe(normalize(expected.get(name) ?? "missing"));
    }

    const sheet = brandHtml.match(/sheets use <code>\(([^)]+)\)<\/code>/)?.[1];
    expect(sheet).toBeDefined();
    expect(normalize(actual.get("--lc-ease-sheet") ?? "")).toBe(
      normalize(`cubic-bezier(${sheet})`),
    );
  });
});
