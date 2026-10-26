import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/features/auth/redirect";
import { formatAge, formatRelative, initials } from "@/lib/format";

const now = Date.parse("2026-10-12T12:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("formatAge", () => {
  it("is compact for dense rows", () => {
    expect(formatAge(ago(20_000), now)).toBe("now");
    expect(formatAge(ago(5 * 60_000), now)).toBe("5m");
    expect(formatAge(ago(3 * 3_600_000), now)).toBe("3h");
    expect(formatAge(ago(2 * 86_400_000), now)).toBe("2d");
    expect(formatAge("2026-09-03T12:00:00.000Z", now)).toBe("Sep 3");
    expect(formatAge("2025-09-03T12:00:00.000Z", now)).toBe("Sep 3, 2025");
    expect(formatAge("not a date", now)).toBe("");
  });

  it("reads as a sentence in the relative form", () => {
    expect(formatRelative(ago(10_000), now)).toBe("just now");
    expect(formatRelative(ago(12 * 60_000), now)).toBe("12 minutes ago");
    expect(formatRelative(ago(86_400_000), now)).toBe("yesterday");
  });
});

describe("initials", () => {
  it("takes the first and last word", () => {
    expect(initials("Nadia Perera")).toBe("NP");
    expect(initials("  ada  ")).toBe("A");
    expect(initials("Mary Ann van Dyke")).toBe("MD");
    expect(initials("")).toBe("?");
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths and refuses everything else", () => {
    expect(safeNextPath("/workspaces?status=archived")).toBe("/workspaces?status=archived");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/login?next=/x")).toBe("/");
  });
});
