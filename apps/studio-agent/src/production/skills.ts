import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  type PulledSkill,
  SKILL_MANIFEST_PATH,
  SkillChecksumSchema,
  type SkillFile,
  SkillFilesSchema,
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

/** A pulled skill that cannot be installed. */
export class SkillSyncError extends Error {
  override readonly name = "SkillSyncError";
}

/** Prefixes of the temporary folders a sync creates next to the skills. */
const STAGING_PREFIX = ".sync-";
const RETIRED_PREFIX = ".old-";

/** Removes staging folders a crashed sync left behind. */
export async function cleanStaging(root: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith(STAGING_PREFIX) || name.startsWith(RETIRED_PREFIX))
      .map((name) => rm(join(root, name), { recursive: true, force: true })),
  );
}

/**
 * Installs one pulled skill into `<root>/<name>/` atomically:
 *
 * 1. the checksum and the file set are checked against the contract;
 * 2. the files are written to a staging folder next to the target;
 * 3. the old folder (if any) is renamed aside, the staging folder renamed into place and the old
 *    folder removed.
 *
 * A failure before step 3 leaves the installed version untouched. Returns false when the same
 * checksum is already installed.
 */
export async function installSkill(
  root: string,
  skill: PulledSkill,
  manifest: SyncManifest,
): Promise<boolean> {
  const files = SkillFilesSchema.safeParse(skill.files);
  if (!files.success) {
    throw new SkillSyncError(`Skill ${skill.name} has an invalid file set`);
  }
  if (skillChecksum(files.data) !== skill.checksum) {
    throw new SkillSyncError(`Skill ${skill.name} does not match its checksum`);
  }
  const target = join(root, SkillNameSchema.parse(skill.name));
  const installed = manifest.skills[skill.name];
  if (installed?.checksum === skill.checksum && (await isDirectory(target))) {
    return false;
  }

  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, `${STAGING_PREFIX}${skill.name}-`));
  try {
    for (const file of files.data) {
      const path = join(staging, ...file.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, { encoding: "utf8", flag: "wx" });
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw new SkillSyncError(
      `Skill ${skill.name} could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const retired = join(root, `${RETIRED_PREFIX}${skill.name}-${randomBytes(4).toString("hex")}`);
  const hadTarget = await isDirectory(target);
  if (hadTarget) {
    await rename(target, retired);
  }
  try {
    await rename(staging, target);
  } catch (error) {
    if (hadTarget) {
      await rename(retired, target).catch(() => {});
    }
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await rm(retired, { recursive: true, force: true });
  return true;
}

/** Records a skill in the manifest and writes it atomically. */
export async function recordSynced(
  root: string,
  manifest: SyncManifest,
  skill: PulledSkill,
  now: Date,
): Promise<SyncManifest> {
  const next: SyncManifest = {
    version: 1,
    skills: {
      ...manifest.skills,
      [skill.name]: {
        kind: skill.kind,
        version: skill.version,
        checksum: skill.checksum,
        syncedAt: now.toISOString(),
      },
    },
  };
  const path = join(root, SYNC_MANIFEST_FILE);
  const temporary = join(root, `.${SYNC_MANIFEST_FILE}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return next;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
