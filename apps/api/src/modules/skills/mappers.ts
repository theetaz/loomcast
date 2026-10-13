import {
  SKILL_MANIFEST_PATH,
  type SkillFile,
  SkillManifestSchema,
  type SkillSummary,
  type SkillVersionDetail,
  type SkillVersionSummary,
} from "@loomcast/contracts";
import type { SkillRow, SkillVersionRow } from "@loomcast/db";

/** Total UTF-8 size of a skill's file contents. */
export function skillBytes(files: readonly SkillFile[]): number {
  return files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
}

/** The description in a version's `skill.json`, or null when it has none (or an unreadable one). */
export function skillDescription(files: readonly SkillFile[]): string | null {
  const manifest = files.find((file) => file.path === SKILL_MANIFEST_PATH);
  if (manifest === undefined) {
    return null;
  }
  try {
    const parsed = SkillManifestSchema.safeParse(JSON.parse(manifest.content));
    return parsed.success ? parsed.data.description : null;
  } catch {
    return null;
  }
}

export function toSkillVersionSummary(
  skill: Pick<SkillRow, "name" | "kind">,
  version: SkillVersionRow,
): SkillVersionSummary {
  return {
    skillId: version.skillId,
    name: skill.name,
    kind: skill.kind,
    version: version.version,
    checksum: version.checksum,
    changelog: version.changelog,
    fileCount: version.files.length,
    bytes: skillBytes(version.files),
    publishedByUser: version.publishedByUser,
    publishedAt: version.createdAt.toISOString(),
  };
}

export function toSkillVersionDetail(
  skill: Pick<SkillRow, "name" | "kind">,
  version: SkillVersionRow,
): SkillVersionDetail {
  return { ...toSkillVersionSummary(skill, version), files: version.files };
}

/** A skill with its current version. */
export function toSkillSummary(skill: SkillRow, current: SkillVersionRow): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    kind: skill.kind,
    description: skillDescription(current.files),
    latestVersion: current.version,
    checksum: current.checksum,
    updatedAt: skill.updatedAt.toISOString(),
  };
}
