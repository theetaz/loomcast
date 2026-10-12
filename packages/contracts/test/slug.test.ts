import { describe, expect, it } from "vitest";
import { SLUG_MAX_LENGTH, SLUG_RE, SlugSchema, slugify } from "../src";

describe("slugify", () => {
  it.each([
    ["Rust in 60 Seconds", "rust-in-60-seconds"],
    ["  Hello,   World!  ", "hello-world"],
    ["Crème brûlée", "creme-brulee"],
    ["Ångström Über Straße", "angstrom-uber-strasse"],
    ["Søren Ærø, Łódź", "soren-aero-lodz"],
    ["C++ & Go: a/b testing", "c-go-a-b-testing"],
    ["already-a-slug", "already-a-slug"],
    ["--leading and trailing--", "leading-and-trailing"],
    ["ＦＵＬＬ　ｗｉｄｔｈ", "full-width"],
    ["日本語", ""],
    ["!!!", ""],
    ["", ""],
  ])("turns %j into %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("cuts long input without leaving a trailing hyphen", () => {
    const slug = slugify(`${"a".repeat(SLUG_MAX_LENGTH - 1)} tail`);

    expect(slug).toBe("a".repeat(SLUG_MAX_LENGTH - 1));
    expect(slugify("one two three", 4)).toBe("one");
  });

  it("produces slugs that match SLUG_RE", () => {
    for (const input of ["Rust in 60 Seconds", "Crème brûlée", `${"word ".repeat(30)}`]) {
      expect(slugify(input)).toMatch(SLUG_RE);
    }
  });
});

describe("SlugSchema", () => {
  it.each(["a", "rust-101", "2026-recap"])("accepts %j", (slug) => {
    expect(SlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each([
    "",
    "Rust",
    "two--hyphens",
    "-leading",
    "trailing-",
    "under_score",
    "a".repeat(SLUG_MAX_LENGTH + 1),
    "4f6d1c2a-8b3e-4a5f-9c7d-1e2f3a4b5c6d",
  ])("rejects %j", (slug) => {
    expect(SlugSchema.safeParse(slug).success).toBe(false);
  });
});
