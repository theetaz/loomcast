import { type ContentReviseResult, ContentReviseResultSchema } from "@loomcast/contracts";
import { type Handler, JobFailure } from "../handlers";
import {
  loadVersion,
  type ProducerStepDeps,
  parsePayload,
  toJobFailure,
  withPlatform,
} from "../production/context";
import { productionDeps } from "../production/deps";
import { runProducerStep } from "../production/producer-step";
import { revisePrompt, stepBrief, stepSkills } from "../production/prompts";
import { readJsonReply } from "../production/reply";
import { loadSkillPack, skillsRoot } from "../production/skills";
import { storyboardProblems } from "../production/storyboard-check";
import { ensureItemWorkspace, writeVersionArtifacts } from "../production/workspace";
import type { HandlerDeps } from "./index";

export function createContentReviseHandler(deps: HandlerDeps): Handler<"content.revise"> {
  return reviseHandler(productionDeps(deps));
}

/**
 * `content.revise`: revises the version's script or storyboard in a new producer session.
 *
 * The owner's review comment (`instructions`) is passed as trusted owner text, unlike knowledge
 * base data. The reply must match `ContentReviseResult`; a revised storyboard must also pass
 * `validateStoryboard`. Up to two repair turns get the problems.
 */
export function reviseHandler(deps: ProducerStepDeps): Handler<"content.revise"> {
  return async (ctx): Promise<ContentReviseResult> => {
    const payload = parsePayload(ctx);
    ctx.emit("status", { state: "starting" });
    try {
      return await withPlatform(ctx, deps.connect, async (platform) => {
        const { item, version } = await loadVersion(platform, payload);
        if (version.script === null && version.storyboard === null) {
          throw new JobFailure(
            "missing_artifact",
            "The version has no script or storyboard to revise",
          );
        }
        const workspace = await ensureItemWorkspace(
          deps.workspaceRoot,
          payload.workspaceId,
          item.id,
          version.versionNo,
        );
        await writeVersionArtifacts(workspace.version, version);

        const studio = await deps.studio();
        const registry = studio.loadRegistry();
        const { rules } = payload.format;
        const { styleId } = rules.visualTemplate;
        const skills = await loadSkillPack(stepSkills("content.revise", rules), {
          skillsRoot: skillsRoot(deps.workspaceRoot),
          bundled: async () => studio.loadBundledSkills(),
          warn: (message, fields) => ctx.log.warn(message, fields),
        });
        const step = await runProducerStep({
          ctx,
          runtime: deps.runtime,
          cwd: workspace.workspaceDir,
          brief: stepBrief({
            step: "content.revise",
            workspaceId: payload.workspaceId,
            item,
            rules,
          }),
          skills,
          prompt: revisePrompt({
            script: version.script,
            storyboard: version.storyboard,
            ...(payload.instructions === undefined ? {} : { instructions: payload.instructions }),
            styleId,
            catalogue: studio.cardCatalogue(registry, styleId),
          }),
          read: (text) => {
            const reply = readJsonReply(text, ContentReviseResultSchema);
            if (!reply.ok || reply.value.storyboard === undefined) {
              return reply;
            }
            const problems = storyboardProblems(reply.value.storyboard, {
              studio,
              registry,
              styleId,
            }).map((problem) => `storyboard.${problem}`);
            return problems.length === 0 ? reply : { ok: false, problems };
          },
          invalidCode: "revision_invalid",
        });
        ctx.log.info("revision written", {
          numTurns: step.numTurns,
          review: payload.reviewId !== undefined,
        });
        return step.value;
      });
    } catch (error) {
      throw toJobFailure(error);
    }
  };
}
