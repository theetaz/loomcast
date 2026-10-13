import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundledSkills } from "../src/skills.ts";

describe("bundled producer skills", () => {
  const skills = loadBundledSkills();

  it("ships the expected skills and recipe with valid manifests", () => {
    expect(skills.map((skill) => [skill.name, skill.kind]).sort()).toEqual([
      ["captions-and-pacing", "skill"],
      ["revision", "skill"],
      ["scriptwriting", "skill"],
      ["storyboarding", "skill"],
      ["vertical-explainer", "recipe"],
    ]);
  });

  it("names each skill after its directory and keeps recipes under recipes/", () => {
    for (const skill of skills) {
      expect(basename(skill.dir)).toBe(skill.name);
      expect(basename(dirname(skill.dir)) === "recipes").toBe(skill.kind === "recipe");
      expect(skill.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "skill.json"]);
    }
  });

  it("stays vendor-neutral and never asks for renders, downloads or commands", () => {
    for (const skill of skills) {
      for (const file of skill.files) {
        expect(file.content).not.toMatch(
          /claude|anthropic|openai|gemini|elevenlabs|hyperframes render|npx|curl|wget/i,
        );
      }
    }
  });
});
