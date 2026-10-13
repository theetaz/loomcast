import { z } from "zod";

/** A skill or recipe name, such as `scriptwriting` or `vertical-explainer`. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const SkillNameSchema = z.string().regex(SKILL_NAME_RE, {
  message: "Use 1 to 64 lowercase letters, digits and hyphens, starting with a letter or digit",
});

/** Published versions of a skill count up from 1. */
export const SkillVersionNumberSchema = z.number().int().min(1);
