import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  SKILL_MANIFEST_PATH,
  SkillChecksumSchema,
  type SkillFile,
  type SkillKind,
  SkillKindSchema,
  SkillManifestSchema,
  SkillNameSchema,
  SkillVersionNumberSchema,
  skillChecksumInput,
} from "@loomcast/contracts";
import { z } from "zod";

/** One skill as a producer session gets it, appended to its system prompt. */
export interface SkillPackEntry {
  readonly name: string;
  readonly kind: SkillKind;
  readonly description: string;
  /** The synced version; bundled skills have none. */
  readonly version?: number;
  readonly source: "synced" | "bundled";
  readonly files: readonly SkillFile[];
}

/** A bundled skill as the studio runtime loads it. */
export interface BundledSkillLike {
  readonly name: string;
  readonly kind: SkillKind;
  readonly description: string;
  readonly files: readonly SkillFile[];
}

/** `<workspaceRoot>/skills`, where `skills.sync` puts published skills. */
export function skillsRoot(workspaceRoot: string): string {
  return join(workspaceRoot, "skills");
}

/** The record of what is synced: `<skillsRoot>/manifest.json`. */
export const SYNC_MANIFEST_FILE = "manifest.json";

const SyncedSkillSchema = z.object({
  kind: SkillKindSchema,
  version: SkillVersionNumberSchema,
  checksum: SkillChecksumSchema,
  syncedAt: z.string(),
});

export const SyncManifestSchema = z.object({
  version: z.literal(1),
  skills: z.record(SkillNameSchema, SyncedSkillSchema),
});
export type SyncManifest = z.infer<typeof SyncManifestSchema>;

/** The sync manifest; a missing or unreadable one is empty. */
export async function readSyncManifest(root: string): Promise<SyncManifest> {
  try {
    return SyncManifestSchema.parse(
      JSON.parse(await readFile(join(root, SYNC_MANIFEST_FILE), "utf8")),
    );
  } catch {
    return { version: 1, skills: {} };
  }
}

/** A skill's checksum: SHA-256 of the UTF-8 bytes of `skillChecksumInput(files)`. */
export function skillChecksum(files: readonly SkillFile[]): string {
  return createHash("sha256").update(skillChecksumInput(files), "utf8").digest("hex");
}

/** Every file below `dir`, as skill files with `/`-separated relative paths. */
async function readSkillDir(dir: string): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push({
          path: relative(dir, path).split(sep).join("/"),
          content: await readFile(path, "utf8"),
        });
      }
    }
  };
  await walk(dir);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface SkillPackOptions {
  readonly skillsRoot: string;
  /** The studio's bundled skills, the fallback for anything not synced. */
  readonly bundled: () => Promise<readonly BundledSkillLike[]>;
  /** Told about skills that are missing or fall back. */
  readonly warn?: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * The skills of a job, in the order named. A synced skill (`<skillsRoot>/<name>/`, listed in the
 * manifest with a matching checksum) wins; otherwise the studio's bundled copy is used. Names that
 * exist in neither place are skipped with a warning. The manifest `skill.json` is not repeated:
 * its description heads the skill.
 */
export async function loadSkillPack(
  names: readonly string[],
  options: SkillPackOptions,
): Promise<SkillPackEntry[]> {
  const manifest = await readSyncManifest(options.skillsRoot);
  let bundled: readonly BundledSkillLike[] | undefined;
  const pack: SkillPackEntry[] = [];
  for (const name of new Set(names)) {
    const synced = manifest.skills[name];
    if (synced !== undefined) {
      const entry = await loadSynced(options.skillsRoot, name, synced).catch(() => undefined);
      if (entry !== undefined) {
        pack.push(entry);
        continue;
      }
      options.warn?.("synced skill is damaged; using the bundled copy", { skill: name });
    }
    bundled ??= await options.bundled().catch((error: unknown) => {
      options.warn?.("bundled skills could not be loaded", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
    const fallback = bundled.find((skill) => skill.name === name);
    if (fallback === undefined) {
      options.warn?.("skill not found; continuing without it", { skill: name });
      continue;
    }
    pack.push({
      name,
      kind: fallback.kind,
      description: fallback.description,
      source: "bundled",
      files: fallback.files.filter((file) => file.path !== SKILL_MANIFEST_PATH),
    });
  }
  return pack;
}

async function loadSynced(
  root: string,
  name: string,
  synced: SyncManifest["skills"][string],
): Promise<SkillPackEntry | undefined> {
  const files = await readSkillDir(join(root, name));
  if (skillChecksum(files) !== synced.checksum) {
    return undefined;
  }
  const manifestFile = files.find((file) => file.path === SKILL_MANIFEST_PATH);
  const manifest =
    manifestFile === undefined
      ? undefined
      : SkillManifestSchema.safeParse(JSON.parse(manifestFile.content)).data;
  return {
    name,
    kind: synced.kind,
    description: manifest?.description ?? `The ${name} ${synced.kind}.`,
    version: synced.version,
    source: "synced",
    files: files.filter((file) => file.path !== SKILL_MANIFEST_PATH),
  };
}
