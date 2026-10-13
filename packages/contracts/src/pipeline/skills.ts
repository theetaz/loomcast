import { z } from "zod";
import { isPlainText } from "../api/kb";
import { SkillKindSchema } from "../enums";
import { utf8ByteLength } from "../util/utf8";

// Skills are versioned packs of text files (instructions, recipes, JSON contracts) that producer
// sessions load. They are published through MCP, stored by the server and synced into each studio
// agent's workspace, so every path must stay inside the skill's own directory.

/** A skill or recipe name, such as `scriptwriting` or `vertical-explainer`. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const SkillNameSchema = z.string().regex(SKILL_NAME_RE, {
  message: "Use 1 to 64 lowercase letters, digits and hyphens, starting with a letter or digit",
});

/** Published versions of a skill count up from 1. */
export const SkillVersionNumberSchema = z.number().int().min(1);

export const SKILL_MAX_FILES = 200;
/** Total size of a skill's file contents, in UTF-8 bytes. */
export const SKILL_MAX_BYTES = 1024 * 1024;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1_000;
export const SKILL_CHANGELOG_MAX_LENGTH = 2_000;

/** The manifest every skill directory carries. */
export const SKILL_MANIFEST_PATH = "skill.json";

/** A relative file path: letters, digits, `.`, `_`, `-` and `/`, never `..`. */
export const SKILL_PATH_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Whether `path` is a plain relative path inside the skill directory: it matches
 * `SKILL_PATH_RE`, does not start or end with `/`, and has no empty or `.` segments.
 */
export function isSkillPath(path: string): boolean {
  if (!SKILL_PATH_RE.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== ".");
}

export const SkillPathSchema = z.string().refine(isSkillPath, {
  message: "Use a relative path inside the skill, such as SKILL.md or templates/hook.md",
});

/** One text file of a skill. */
export const SkillFileSchema = z.object({
  path: SkillPathSchema,
  content: z.string().refine(isPlainText, {
    message: "Skill files must be text without control characters",
  }),
});
export type SkillFile = z.infer<typeof SkillFileSchema>;

/**
 * The files of a skill: 1 to 200, at most 1 MiB in total, and no two paths that differ only in
 * case (they would collide on a case-insensitive disk).
 */
export const SkillFilesSchema = z
  .array(SkillFileSchema)
  .min(1)
  .max(SKILL_MAX_FILES)
  .superRefine((files, ctx) => {
    const seen = new Set<string>();
    files.forEach((file, index) => {
      const key = file.path.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: "File paths must not repeat, ignoring case",
          path: [index, "path"],
        });
      }
      seen.add(key);
    });
    const bytes = files.reduce((total, file) => total + utf8ByteLength(file.content), 0);
    if (bytes > SKILL_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: "A skill must total at most 1 MiB" });
    }
  });

/** `skill.json`: the name, kind and a one-paragraph description. */
export const SkillManifestSchema = z.object({
  name: SkillNameSchema,
  kind: SkillKindSchema,
  description: z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

/** A skill checksum: lowercase hex SHA-256. */
export const SkillChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The text a skill checksum is the SHA-256 of: every `path`, NUL, `content`, sorted by path and
 * joined with NUL. Paths and contents never contain NUL, so the encoding is unambiguous. The
 * server and the studio agent hash the UTF-8 bytes of this string.
 */
export function skillChecksumInput(files: readonly SkillFile[]): string {
  return [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\u0000${file.content}`)
    .join("\u0000");
}
