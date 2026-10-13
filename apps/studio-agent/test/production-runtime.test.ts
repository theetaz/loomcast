import { join, resolve } from "node:path";
import { itemLayout } from "@loomcast/studio/runtime";
import { describe, expect, it } from "vitest";
import { createMcpCredentials } from "../src/handlers";
import { qualifiedToolName } from "../src/producer/mcp";
import {
  MAX_SKILL_PACK_CHARS,
  SdkProducerRuntime,
  withSkillPack,
} from "../src/producer/sdk-runtime";
import { STEP_SKILLS, stepSkills } from "../src/production/prompts";
import { resolveStudioRoot, STUDIO_ROOT_ENV, studioLoader } from "../src/production/studio";
import { versionLayout } from "../src/production/workspace";
import { testJobToken } from "./helpers";
import { rules } from "./production-fakes";

const repoStudio = resolve(import.meta.dirname, "..", "..", "..", "studio");

describe("studio runtime adapter", () => {
  it("finds the studio folder from the sources and from the built bundle", () => {
    expect(resolveStudioRoot({}, import.meta.url)).toBe(repoStudio);
    const bundled = join(repoStudio, "..", "apps", "studio-agent", "dist", "cli.mjs");
    expect(resolveStudioRoot({}, bundled)).toBe(repoStudio);
    expect(resolveStudioRoot({ [STUDIO_ROOT_ENV]: "/opt/studio" })).toBe("/opt/studio");
  });

  it("binds the studio runtime to the studio folder without rendering anything", async () => {
    const studio = await studioLoader(repoStudio)();
    expect(studio.studioRoot).toBe(repoStudio);
    expect(studio.hyperframesBin).toBe(
      join(repoStudio, "node_modules", "hyperframes", "bin", "hyperframes.mjs"),
    );
    const names = studio.loadBundledSkills().map((skill) => skill.name);
    for (const step of Object.values(STEP_SKILLS)) {
      for (const name of step) {
        expect(names).toContain(name);
      }
    }
    const registry = studio.loadRegistry();
    expect(studio.cardCatalogue(registry, "vox-explainer").length).toBeGreaterThan(0);
  });

  it("uses the same version layout as the studio runtime", () => {
    const dir = "/w/projects/p/items/i/v3";
    expect(versionLayout(dir)).toEqual(itemLayout(dir));
  });

  it("adds the format's recipe after the step's skills", () => {
    expect(
      stepSkills("content.write_script", rules({ recipe: { name: "vertical-explainer" } })),
    ).toEqual([...STEP_SKILLS["content.write_script"], "vertical-explainer"]);
  });
});

describe("skill pack in the system prompt", () => {
  const skill = (name: string, content: string) => ({
    name,
    kind: "skill" as const,
    description: `About ${name}.`,
    source: "bundled" as const,
    files: [{ path: "SKILL.md", content }],
  });

  it("appends each skill after the brief and leaves out what does not fit", () => {
    const text = withSkillPack("BRIEF", [
      skill("one", "First skill."),
      skill("huge", "x".repeat(MAX_SKILL_PACK_CHARS)),
      skill("two", "Second skill."),
    ]);
    expect(text.startsWith("BRIEF\n\n# Skill pack")).toBe(true);
    expect(text).toContain(
      "## Skill: one (skill)\n\nAbout one.\n\n### one/SKILL.md\n\nFirst skill.",
    );
    expect(text).toContain("## Skill: two (skill)");
    expect(text).not.toContain("xxxxxxxxxx");
    expect(text).toContain("Skills left out for length: huge.");
    expect(withSkillPack("BRIEF", [])).toBe("BRIEF");
  });

  it("configures a storyboard session: Bash on, guarded by the hook, read-only MCP tools", () => {
    const runtime = new SdkProducerRuntime({ env: {} });
    const options = runtime.options(
      {
        cwd: "/w/projects/p",
        jobType: "content.storyboard",
        brief: "BRIEF",
        skills: [skill("storyboarding", "Cards.")],
        commandScope: { itemDir: "/w/projects/p/items/i", hyperframesBin: "/s/hf.mjs" },
        mcp: createMcpCredentials(
          new URL("http://127.0.0.1:8790/mcp"),
          testJobToken(),
          "2026-10-13T10:00:00.000Z",
        ),
      },
      new AbortController(),
    );
    expect(options.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(options.disallowedTools).not.toContain("Bash");
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining([
        "Write",
        "Edit",
        "WebSearch",
        "WebFetch",
        qualifiedToolName("content.submit_for_review"),
        qualifiedToolName("content.upload_asset"),
      ]),
    );
    expect(options.disallowedTools).not.toContain(qualifiedToolName("content.get"));
    expect(options.allowedTools).toBeUndefined();
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(options.systemPrompt).toMatchObject({
      append: expect.stringContaining("## Skill: storyboarding"),
    });

    for (const jobType of [
      "producer.chat",
      "content.write_script",
      "content.revise",
      "kb.analyze_reference",
    ] as const) {
      const other = runtime.options({ cwd: "/w/projects/p", jobType }, new AbortController());
      expect(other.tools).not.toContain("Bash");
      expect(other.disallowedTools).toContain("Bash");
    }
  });
});
