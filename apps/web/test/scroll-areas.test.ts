import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every region that scrolls uses the shared ScrollArea, so scrollbars match the theme. A native
// scroll container (`overflow-auto`, `overflow-y-scroll`, ...) draws the browser scrollbar.

const root = join(import.meta.dirname, "..", "..", "..");
const sources = [join(root, "apps/web/src"), join(root, "packages/ui/src")];

/**
 * Popups whose content only scrolls when the window is too short to fit it. Radix positions and
 * focuses their items, and wrapping them in a ScrollArea breaks keyboard navigation.
 */
const allowed = new Set([
  "packages/ui/src/components/dropdown-menu.tsx",
  "packages/ui/src/components/select.tsx",
]);

const nativeScroll = /\boverflow-(?:[xy]-)?(?:auto|scroll)\b/;

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("scroll areas", () => {
  it("uses the shared ScrollArea instead of native scroll containers", () => {
    const offenders = sources.flatMap((source) =>
      filesIn(source).flatMap((file) => {
        const path = relative(root, file);
        if (allowed.has(path)) return [];
        return readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, index) => (nativeScroll.test(line) ? [`${path}:${index + 1}`] : []));
      }),
    );
    expect(offenders).toEqual([]);
  });
});
