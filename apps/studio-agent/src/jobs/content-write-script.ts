import {
  type ContentWriteScriptResult,
  MAX_ANALYSIS_SUMMARY_LENGTH,
  ScriptSchema,
} from "@loomcast/contracts";
import type { Handler } from "../handlers";
import {
  loadVersion,
  type ProducerStepDeps,
  parsePayload,
  toJobFailure,
  withPlatform,
} from "../production/context";
import { productionDeps } from "../production/deps";
import { runProducerStep } from "../production/producer-step";
import { stepBrief, stepSkills, writeScriptPrompt } from "../production/prompts";
import { readJsonReply, truncate } from "../production/reply";
import { loadSkillPack, skillsRoot } from "../production/skills";
import { ensureItemWorkspace, writeVersionArtifacts } from "../production/workspace";
import type { HandlerDeps } from "./index";

export function createContentWriteScriptHandler(
  deps: HandlerDeps,
): Handler<"content.write_script"> {
  return writeScriptHandler(productionDeps(deps));
}

/**
 * `content.write_script`: writes the item's script in a new producer session.
 *
 * The session starts in the project workspace with the script skills, the format rules and the
 * item's topic appended to its system prompt. Its reply must hold one fenced JSON block matching
 * `ScriptSchema`; up to two repair turns get the problems. Text after the block becomes the notes.
 */
export function writeScriptHandler(deps: ProducerStepDeps): Handler<"content.write_script"> {
  return async (ctx): Promise<ContentWriteScriptResult> => {
    const payload = parsePayload(ctx);
    ctx.emit("status", { state: "starting" });
    try {
      return await withPlatform(ctx, deps.connect, async (platform) => {
        const { item, version } = await loadVersion(platform, payload);
        const workspace = await ensureItemWorkspace(
          deps.workspaceRoot,
          payload.projectId,
          item.id,
          version.versionNo,
        );
        await writeVersionArtifacts(workspace.version, version);
        const { rules } = payload.format;
        const skills = await loadSkillPack(stepSkills("content.write_script", rules), {
          skillsRoot: skillsRoot(deps.workspaceRoot),
          bundled: async () => (await deps.studio()).loadBundledSkills(),
          warn: (message, fields) => ctx.log.warn(message, fields),
        });
        const step = await runProducerStep({
          ctx,
          runtime: deps.runtime,
          cwd: workspace.projectDir,
          brief: stepBrief({
            step: "content.write_script",
            projectId: payload.projectId,
            item,
            rules,
          }),
          skills,
          prompt: writeScriptPrompt({ rules }),
          read: (text) => readJsonReply(text, ScriptSchema),
          invalidCode: "script_invalid",
        });
        ctx.log.info("script written", { numTurns: step.numTurns });
        const notes = truncate(step.rest, MAX_ANALYSIS_SUMMARY_LENGTH).trim();
        return { script: step.value, ...(notes.length > 0 ? { notes } : {}) };
      });
    } catch (error) {
      throw toJobFailure(error);
    }
  };
}
