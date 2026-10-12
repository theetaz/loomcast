import { cn } from "@loomcast/ui/lib/cn";
import { describe, expect, it } from "vitest";

describe("cn", () => {
  it("joins conditional classes", () => {
    expect(cn("px-2", false, undefined, { "py-1": true, hidden: false })).toBe("px-2 py-1");
  });

  it("keeps a Loomcast text size next to a text colour", () => {
    expect(cn("text-body text-foreground")).toBe("text-body text-foreground");
    expect(cn("text-mono", "text-text-4")).toBe("text-mono text-text-4");
  });

  it("lets a later Loomcast size, shadow or duration win", () => {
    expect(cn("text-body", "text-small")).toBe("text-small");
    expect(cn("shadow-card", "shadow-pop")).toBe("shadow-pop");
    expect(cn("duration-menu-in", "duration-menu-out")).toBe("duration-menu-out");
    expect(cn("ease-out", "ease-sheet")).toBe("ease-sheet");
  });
});
