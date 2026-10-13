import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  type SkillFile,
  SkillFilesSchema,
  type SkillManifest,
  SkillManifestSchema,
} from "@loomcast/contracts";
import { studioPaths } from "./paths.ts";

// The producer skills bundled with the studio (`studio/skills/`). A skill is a directory with a
// `skill.json` manifest; recipes sit one level down under `recipes/`. The studio agent publishes
// and syncs these, and falls back to them when nothing has been synced.

export interface BundledSkill extends SkillManifest {
  dir: string;
  files: SkillFile[];
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function skillDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    if (existsSync(join(dir, "skill.json"))) dirs.push(dir);
    else dirs.push(...skillDirs(dir));
  }
  return dirs.sort();
}

/** Loads and validates every bundled skill. Throws on an invalid manifest or file set. */
export function loadBundledSkills(options: { studioRoot?: string; skillsDir?: string } = {}) {
  const root = options.skillsDir ?? studioPaths(options.studioRoot).skills;
  const skills: BundledSkill[] = [];
  const names = new Set<string>();
  for (const dir of skillDirs(root)) {
    const manifest = SkillManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, "skill.json"), "utf8")),
    );
    if (names.has(manifest.name)) throw new Error(`Skill ${manifest.name} is defined twice`);
    names.add(manifest.name);
    const files = SkillFilesSchema.parse(
      listFiles(dir)
        .filter((path) => statSync(path).isFile())
        .map((path) => ({
          path: relative(dir, path).split(sep).join("/"),
          content: readFileSync(path, "utf8"),
        })),
    );
    skills.push({ ...manifest, dir, files });
  }
  return skills;
}
