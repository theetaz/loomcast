import { mkdir } from "node:fs/promises";
import { type PulledSkill, SKILLS_SYNC_MAX, type SkillsSyncResult } from "@loomcast/contracts";
import { type Handler, JobFailure } from "../handlers";
import {
  type ProductionDeps,
  ProgressReporter,
  parsePayload,
  toJobFailure,
  withPlatform,
} from "../production/context";
import { productionDeps } from "../production/deps";
import {
  cleanStaging,
  installSkill,
  readSyncManifest,
  recordSynced,
  SkillSyncError,
  skillsRoot,
} from "../production/skills";
import type { HandlerDeps } from "./index";

export function createSkillsSyncHandler(deps: HandlerDeps): Handler<"skills.sync"> {
  return skillsSyncHandler(productionDeps(deps));
}

/**
 * `skills.sync`: pulls published skills (all of them, or the named ones) into
 * `<workspaceRoot>/skills/<name>/`.
 *
 * Each skill is checked against its checksum, written to a staging folder and renamed into
 * place, so a session never sees a half-written skill and a failed sync keeps the installed
 * version. `manifest.json` records the synced name, kind, version and checksum; the skill-pack
 * loader prefers these skills and falls back to the studio's bundled ones.
 */
export function skillsSyncHandler(deps: ProductionDeps): Handler<"skills.sync"> {
  return async (ctx): Promise<SkillsSyncResult> => {
    const payload = parsePayload(ctx);
    ctx.emit("status", { state: "starting" });
    try {
      return await withPlatform(ctx, deps.connect, async (platform) => {
        const root = skillsRoot(deps.workspaceRoot);
        await mkdir(root, { recursive: true });
        await cleanStaging(root);

        const pulled: PulledSkill[] = [];
        if (payload.names === undefined) {
          pulled.push(...(await platform.pullSkills({})).skills);
        } else {
          for (const name of payload.names) {
            const { skills } = await platform.pullSkills({ name });
            const skill = skills.find((candidate) => candidate.name === name);
            if (skill === undefined) {
              throw new JobFailure("skill_not_found", `No published skill is named ${name}`);
            }
            pulled.push(skill);
          }
        }
        if (pulled.length > SKILLS_SYNC_MAX) {
          throw new JobFailure("too_many_skills", `At most ${SKILLS_SYNC_MAX} skills sync at once`);
        }

        let manifest = await readSyncManifest(root);
        const progress = new ProgressReporter((state, value) =>
          ctx.emit("status", { state, progress: value }),
        );
        const now = deps.now ?? (() => new Date());
        const synced: SkillsSyncResult["synced"] = [];
        let changed = 0;
        for (const [index, skill] of pulled.entries()) {
          ctx.signal.throwIfAborted();
          progress.report("syncing", index / Math.max(pulled.length, 1));
          if (await installSkill(root, skill, manifest)) {
            changed += 1;
          }
          if (manifest.skills[skill.name]?.checksum !== skill.checksum) {
            manifest = await recordSynced(root, manifest, skill, now());
          }
          synced.push({ name: skill.name, version: skill.version });
        }
        progress.report("syncing", 1);
        ctx.log.info("skills synced", { skills: synced.length, changed });
        return { synced };
      });
    } catch (error) {
      if (error instanceof SkillSyncError) {
        throw new JobFailure("skill_invalid", error.message, false);
      }
      throw toJobFailure(error, "skills_sync_failed");
    }
  };
}
