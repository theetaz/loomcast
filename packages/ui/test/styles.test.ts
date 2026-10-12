import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type AtRule, type Container, type Root } from "postcss";
import { beforeAll, describe, expect, it } from "vitest";

// Compiles the stylesheet the way an app does (import plus `@source`), so every
// class the components use is generated and checked against the motion rules.
// Scanning starts at `src` so this README and the tests do not add classes.
const packageDir = fileURLToPath(new URL("..", import.meta.url));

let css: string;
let root: Root;

beforeAll(async () => {
  // The inline source adds the scale utilities that apps use but components do not.
  const entry = [
    '@import "./src/styles.css";',
    '@source "./src";',
    '@source inline("text-display text-title text-heading text-body text-small text-mono font-mono");',
  ].join("\n");
  const result = await postcss([tailwindcss({ base: join(packageDir, "src") })]).process(entry, {
    from: join(packageDir, "entry.css"),
  });
  css = result.css;
  root = postcss.parse(css);
}, 60_000);

function declarations(property: string | RegExp): string[] {
  const values: string[] = [];
  root.walkDecls(property, (decl) => {
    values.push(decl.value.replace(/\s+/g, " ").trim());
  });
  return values;
}

function splitList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
}

function insideMedia(node: Container | undefined, params: RegExp): boolean {
  for (let parent = node?.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && (parent as AtRule).name === "media") {
      if (params.test((parent as AtRule).params)) return true;
    }
  }
  return false;
}

const BRAND_DURATION =
  /^var\(--lc-duration-(press|menu-in|menu-out|tabs|toast-in|toast-out|color)\)$/;
const BRAND_EASE = /^(ease|var\(--lc-ease(-io|-sheet)?\)|var\(--tw-ease, ease\))$/;

describe("compiled stylesheet", () => {
  it("never transitions every property", () => {
    expect(css).not.toMatch(/transition(-property)?:\s*all\b/);
    expect(declarations("transition-property")).not.toContain("all");
  });

  it("times every transition with a brand duration", () => {
    const values = [...declarations("transition-duration"), ...declarations("--tw-duration")];
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      for (const part of splitList(value.replace(/\s*!important$/, ""))) {
        if (part === "initial") continue;
        const fallback = part.match(/^var\(--tw-duration, (.*)\)$/);
        expect(fallback?.[1] ?? part).toMatch(BRAND_DURATION);
      }
    }
  });

  it("eases every transition with a brand curve or plain ease for colour", () => {
    const values = [...declarations("transition-timing-function"), ...declarations("--tw-ease")];
    for (const value of values) {
      for (const part of splitList(value)) {
        if (part === "initial") continue;
        expect(part).toMatch(BRAND_EASE);
      }
    }
  });

  it("drives tw-animate enter and exit with the menu timings and brand ease-out", () => {
    const animations = declarations(/^(animation|--animate-in|--animate-out)$/);
    const enter = animations.filter((value) => value.startsWith("enter "));
    const exit = animations.filter((value) => value.startsWith("exit "));
    expect(enter.length).toBeGreaterThan(0);
    expect(exit.length).toBeGreaterThan(0);
    for (const value of enter) {
      expect(value).toContain("var(--lc-duration-menu-in)");
      expect(value).toContain("var(--tw-ease, var(--lc-ease))");
    }
    for (const value of exit) {
      expect(value).toContain("var(--lc-duration-menu-out)");
      expect(value).toContain("var(--tw-ease, var(--lc-ease))");
    }
    // The only other animations are the looping skeleton pulse and loader spin.
    const others = animations.filter((value) => !/^(enter|exit) /.test(value));
    for (const value of others) {
      expect(["none", "var(--animate-pulse)", "var(--animate-spin)"]).toContain(value);
    }
  });

  it("applies hover styles only on devices with a fine pointer", () => {
    let hoverRules = 0;
    root.walkRules((rule) => {
      if (!rule.selector.includes(":hover")) return;
      hoverRules++;
      expect(insideMedia(rule, /\(hover: hover\) and \(pointer: fine\)/), rule.selector).toBe(true);
    });
    expect(hoverRules).toBeGreaterThan(0);
  });

  it("presses buttons to 0.97 over 140ms on the brand ease, except under reduced motion", () => {
    const active: string[] = [];
    root.walkRules(".pressable", (pressable) => {
      pressable.walkRules(/:active/, (rule) => {
        rule.walkDecls("transform", (decl) => {
          const reduced = insideMedia(rule, /prefers-reduced-motion: reduce/);
          active.push(`${reduced ? "reduced" : "default"}:${decl.value}`);
        });
      });
    });
    expect(active).toEqual(["default:scale(0.97)", "reduced:none"]);
    expect(css).toMatch(
      /\.pressable \{[^}]*transition-property: transform[^}]*var\(--lc-duration-press\)[^}]*var\(--lc-ease\)/,
    );
  });

  it("scales menus from 0.97 out of their trigger", () => {
    expect(css).toContain("transform-origin: var(--radix-dropdown-menu-content-transform-origin)");
    expect(css).toContain("transform-origin: var(--radix-select-content-transform-origin)");
    expect(css).toContain("transform-origin: var(--radix-tooltip-content-transform-origin)");
    expect(css).toMatch(/--tw-enter-scale: calc\(97 ?\* ?1%\)/);
    expect(css).toMatch(/--tw-exit-scale: calc\(97 ?\* ?1%\)/);
  });

  it("keeps fades but removes movement under reduced motion", () => {
    const reduced: Record<string, string> = {};
    root.walkAtRules("media", (media) => {
      if (!media.params.includes("prefers-reduced-motion: reduce")) return;
      media.walkDecls(/^--tw-(enter|exit)-/, (decl) => {
        reduced[decl.prop] = decl.value;
      });
    });
    expect(reduced).toMatchObject({
      "--tw-enter-scale": "1",
      "--tw-exit-scale": "1",
      "--tw-enter-translate-x": "0",
      "--tw-enter-translate-y": "0",
      "--tw-exit-translate-x": "0",
      "--tw-exit-translate-y": "0",
    });
    expect(Object.keys(reduced).some((prop) => prop.includes("opacity"))).toBe(false);
    expect(css).toMatch(/transition: opacity var\(--lc-duration-toast-in\) ease !important/);
  });

  it("exposes the Loomcast scale as utilities", () => {
    expect(css).toMatch(/--radius-sm: 4px;/);
    expect(css).toMatch(/--radius-md: 7px;/);
    expect(css).toMatch(/--radius-lg: 10px;/);
    expect(css).toMatch(/--radius-xl: 14px;/);
    expect(css).toMatch(/--text-display: 23px;/);
    expect(css).toMatch(/--text-body: 13\.5px;/);
    expect(css).toMatch(/--text-mono: 11\.5px;/);
    expect(css).toMatch(/--font-sans: "Geist Variable"/);
    expect(css).toMatch(/--font-mono: "Geist Mono Variable"/);
    expect(css).toMatch(/\.shadow-card \{[^}]*var\(--lc-shadow-card\)/);
    expect(css).toMatch(/\.bg-status-green\\\/11 \{/);
    expect(css).toMatch(/font-family: 'Geist Variable'/);
  });
});
