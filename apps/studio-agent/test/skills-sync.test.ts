import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJobResult } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import { skillsSyncHandler } from "../src/jobs/skills-sync";
import {
  cleanStaging,
  installSkill,
  loadSkillPack,
  readSyncManifest,
  skillChecksum,
} from "../src/production/skills";
import {
  contentItem,
  contentVersion,
  FakePlatform,
  fakeStudio,
  jobContext,
  productionDeps,
  pulledSkill,
  tempDir,
} from "./production-fakes";

const manifestFile = (name: string, kind = "skill") => ({
  path: "skill.json",
  content: JSON.stringify({ name, kind, description: `The ${name} skill.` }),
});

function setup() {
  const root = tempDir("loomcast-skills-");
  const platform = new FakePlatform({
    item: contentItem(),
    version: contentVersion(),
    format: null,
  });
  const deps = productionDeps({ workspaceRoot: root, platform, studio: fakeStudio(tempDir()) });
  return { root, skillsDir: join(root, "skills"), platform, deps };
}

const scriptwriting = pulledSkill("scriptwriting", 2, [
  manifestFile("scriptwriting"),
  { path: "SKILL.md", content: "# Scriptwriting v2" },
  { path: "templates/hook.md", content: "Hook template" },
]);
const storyboarding = pulledSkill("storyboarding", 1, [
  manifestFile("storyboarding"),
  { path: "SKILL.md", content: "# Storyboarding" },
]);

describe("skills.sync", () => {
  it("pulls every skill into <workspace>/skills/<name>/ and records the manifest", async () => {
    const { skillsDir, platform, deps } = setup();
    platform.skills = [scriptwriting, storyboarding];
    const { ctx, events } = jobContext("skills.sync", {});

    const result = await skillsSyncHandler({
      ...deps,
      now: () => new Date("2026-10-13T09:00:00Z"),
    })(ctx);

    expect(parseJobResult("skills.sync", result).success).toBe(true);
    expect(result).toEqual({
      synced: [
        { name: "scriptwriting", version: 2 },
        { name: "storyboarding", version: 1 },
      ],
    });
    expect(platform.toolCalls("skill.pull")).toEqual([{}]);
    expect(readFileSync(join(skillsDir, "scriptwriting", "templates", "hook.md"), "utf8")).toBe(
      "Hook template",
    );
    expect(await readSyncManifest(skillsDir)).toEqual({
      version: 1,
      skills: {
        scriptwriting: {
          kind: "skill",
          version: 2,
          checksum: scriptwriting.checksum,
          syncedAt: "2026-10-13T09:00:00.000Z",
        },
        storyboarding: {
          kind: "skill",
          version: 1,
          checksum: storyboarding.checksum,
          syncedAt: "2026-10-13T09:00:00.000Z",
        },
      },
    });
    expect(readdirSync(skillsDir).sort()).toEqual([
      "manifest.json",
      "scriptwriting",
      "storyboarding",
    ]);
    expect(events.every((event) => event.kind === "status")).toBe(true);
  });

  it("pulls the named skills one by one and fails on an unknown name", async () => {
    const { platform, deps } = setup();
    platform.skills = [scriptwriting, storyboarding];
    const result = await skillsSyncHandler(deps)(
      jobContext("skills.sync", { names: ["storyboarding"] }).ctx,
    );
    expect(result.synced).toEqual([{ name: "storyboarding", version: 1 }]);
    expect(platform.toolCalls("skill.pull")).toEqual([{ name: "storyboarding" }]);

    await expect(
      skillsSyncHandler(deps)(jobContext("skills.sync", { names: ["missing"] }).ctx),
    ).rejects.toMatchObject({ code: "skill_not_found" });
  });

  it("replaces a skill atomically and keeps the old version when the new one fails", async () => {
    const { skillsDir, platform, deps } = setup();
    platform.skills = [scriptwriting];
    await skillsSyncHandler(deps)(jobContext("skills.sync", {}).ctx);

    // "a" is both a file and a folder: writing the new version fails halfway.
    const broken = pulledSkill("scriptwriting", 3, [
      manifestFile("scriptwriting"),
      { path: "a/b.md", content: "nested" },
      { path: "a", content: "clash" },
    ]);
    platform.skills = [broken];
    await expect(skillsSyncHandler(deps)(jobContext("skills.sync", {}).ctx)).rejects.toMatchObject({
      code: "skill_invalid",
    });
    expect(readFileSync(join(skillsDir, "scriptwriting", "SKILL.md"), "utf8")).toBe(
      "# Scriptwriting v2",
    );
    expect((await readSyncManifest(skillsDir)).skills.scriptwriting?.version).toBe(2);
    expect(readdirSync(skillsDir).filter((name) => name.startsWith("."))).toEqual([]);

    const next = pulledSkill("scriptwriting", 3, [
      manifestFile("scriptwriting"),
      { path: "SKILL.md", content: "# Scriptwriting v3" },
    ]);
    platform.skills = [next];
    await skillsSyncHandler(deps)(jobContext("skills.sync", {}).ctx);
    expect(readFileSync(join(skillsDir, "scriptwriting", "SKILL.md"), "utf8")).toBe(
      "# Scriptwriting v3",
    );
    // Files of the old version are gone with it.
    expect(existsSync(join(skillsDir, "scriptwriting", "templates"))).toBe(false);
    expect((await readSyncManifest(skillsDir)).skills.scriptwriting?.version).toBe(3);
  });

  it("refuses a skill whose files do not match its checksum", async () => {
    const { skillsDir, platform, deps } = setup();
    platform.skills = [{ ...storyboarding, checksum: scriptwriting.checksum }];
    await expect(skillsSyncHandler(deps)(jobContext("skills.sync", {}).ctx)).rejects.toMatchObject({
      code: "skill_invalid",
    });
    expect(existsSync(join(skillsDir, "storyboarding"))).toBe(false);
  });

  it("leaves an unchanged skill alone and removes staging left by a crash", async () => {
    const { skillsDir } = setup();
    const manifest = await readSyncManifest(skillsDir);
    expect(await installSkill(skillsDir, storyboarding, manifest)).toBe(true);
    const recorded = {
      ...manifest,
      skills: {
        storyboarding: {
          kind: "skill" as const,
          version: 1,
          checksum: storyboarding.checksum,
          syncedAt: "2026-10-13T09:00:00.000Z",
        },
      },
    };
    expect(await installSkill(skillsDir, storyboarding, recorded)).toBe(false);
    mkdirSync(join(skillsDir, ".sync-storyboarding-abc"));
    mkdirSync(join(skillsDir, ".old-storyboarding-abc"));
    await cleanStaging(skillsDir);
    expect(readdirSync(skillsDir)).toEqual(["storyboarding"]);
  });
});

describe("skill pack loader", () => {
  it("prefers synced skills, falls back to bundled ones and skips unknown names", async () => {
    const { skillsDir } = setup();
    const manifest = await readSyncManifest(skillsDir);
    await installSkill(skillsDir, scriptwriting, manifest);
    writeFileSync(
      join(skillsDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        skills: {
          scriptwriting: {
            kind: "skill",
            version: 2,
            checksum: scriptwriting.checksum,
            syncedAt: "2026-10-13T09:00:00.000Z",
          },
        },
      }),
    );
    const warnings: string[] = [];
    const bundled = [
      {
        name: "storyboarding",
        kind: "skill" as const,
        description: "Bundled storyboarding.",
        files: [manifestFile("storyboarding"), { path: "SKILL.md", content: "# Bundled" }],
      },
    ];
    const pack = await loadSkillPack(["scriptwriting", "storyboarding", "missing"], {
      skillsRoot: skillsDir,
      bundled: async () => bundled,
      warn: (message) => warnings.push(message),
    });
    expect(pack.map((skill) => [skill.name, skill.source, skill.version])).toEqual([
      ["scriptwriting", "synced", 2],
      ["storyboarding", "bundled", undefined],
    ]);
    expect(pack[0]?.description).toBe("The scriptwriting skill.");
    expect(pack[0]?.files.map((file) => file.path)).toEqual(["SKILL.md", "templates/hook.md"]);
    expect(pack[1]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(warnings).toEqual(["skill not found; continuing without it"]);
  });

  it("falls back to the bundled copy when a synced skill was changed on disk", async () => {
    const { skillsDir } = setup();
    await installSkill(skillsDir, storyboarding, await readSyncManifest(skillsDir));
    writeFileSync(
      join(skillsDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        skills: {
          storyboarding: {
            kind: "skill",
            version: 1,
            checksum: storyboarding.checksum,
            syncedAt: "2026-10-13T09:00:00.000Z",
          },
        },
      }),
    );
    writeFileSync(join(skillsDir, "storyboarding", "SKILL.md"), "tampered");
    const pack = await loadSkillPack(["storyboarding"], {
      skillsRoot: skillsDir,
      bundled: async () => [
        {
          name: "storyboarding",
          kind: "skill",
          description: "Bundled.",
          files: [{ path: "SKILL.md", content: "ok" }],
        },
      ],
    });
    expect(pack[0]?.source).toBe("bundled");
    expect(skillChecksum([{ path: "SKILL.md", content: "ok" }])).toMatch(/^[a-f0-9]{64}$/);
  });
});
