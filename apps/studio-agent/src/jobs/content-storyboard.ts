import {
  type ContentStoryboardResult,
  StoryboardSchema,
  type VoiceAlignment,
} from "@loomcast/contracts";
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
import { stepBrief, stepSkills, storyboardPrompt } from "../production/prompts";
import { readJsonReply } from "../production/reply";
import { loadSkillPack, skillsRoot } from "../production/skills";
import { storyboardProblems } from "../production/storyboard-check";
import {
  ensureItemWorkspace,
  writeJsonAtomic,
  writeVersionArtifacts,
} from "../production/workspace";
import type { HandlerDeps } from "./index";

export function createContentStoryboardHandler(deps: HandlerDeps): Handler<"content.storyboard"> {
  return storyboardHandler(productionDeps(deps));
}

/**
 * `content.storyboard`: sets the version's script to cards of the format's style in a new
 * producer session.
 *
 * - The prompt carries the style's card catalogue from the studio runtime; the voice length and
 *   word timings are added when the version already has a voice take.
 * - The reply must match `StoryboardSchema` and pass `validateStoryboard` against the card
 *   registry (and the voice length); up to two repair turns get the errors.
 */
export function storyboardHandler(deps: ProducerStepDeps): Handler<"content.storyboard"> {
  return async (ctx): Promise<ContentStoryboardResult> => {
    const payload = parsePayload(ctx);
    ctx.emit("status", { state: "starting" });
    try {
      return await withPlatform(ctx, deps.connect, async (platform) => {
        const { item, version } = await loadVersion(platform, payload);
        if (version.script === null) {
          throw new JobFailure("missing_artifact", "The version has no script to storyboard");
        }
        const workspace = await ensureItemWorkspace(
          deps.workspaceRoot,
          payload.projectId,
          item.id,
          version.versionNo,
        );
        await writeVersionArtifacts(workspace.version, version);

        const studio = await deps.studio();
        const registry = studio.loadRegistry();
        const { rules } = payload.format;
        const { styleId } = rules.visualTemplate;
        const catalogue = studio.cardCatalogue(registry, styleId);
        if (catalogue.length === 0) {
          throw new JobFailure(
            "unknown_style",
            `The style library on this Mac has no cards for the style ${styleId}`,
          );
        }

        let voice: { durationMs: number; alignment: VoiceAlignment | null } | undefined;
        if (version.voiceAssetId !== null) {
          const { asset } = await platform.getAssetUrl({ assetId: version.voiceAssetId });
          if (asset.durationMs !== null && asset.durationMs > 0) {
            voice = { durationMs: asset.durationMs, alignment: asset.alignment };
            if (asset.alignment !== null) {
              await writeJsonAtomic(workspace.version.alignment, asset.alignment);
            }
          }
        }

        const skills = await loadSkillPack(stepSkills("content.storyboard", rules), {
          skillsRoot: skillsRoot(deps.workspaceRoot),
          bundled: async () => studio.loadBundledSkills(),
          warn: (message, fields) => ctx.log.warn(message, fields),
        });
        const step = await runProducerStep({
          ctx,
          runtime: deps.runtime,
          cwd: workspace.projectDir,
          brief: stepBrief({
            step: "content.storyboard",
            projectId: payload.projectId,
            item,
            rules,
          }),
          skills,
          prompt: storyboardPrompt({
            script: version.script,
            styleId,
            catalogue,
            voice,
            versionDir: workspace.version.dir,
          }),
          read: (text) => {
            const reply = readJsonReply(text, StoryboardSchema);
            if (!reply.ok) {
              return reply;
            }
            const problems = storyboardProblems(reply.value, {
              studio,
              registry,
              styleId,
              voiceDurationMs: voice?.durationMs,
            });
            return problems.length === 0 ? reply : { ok: false, problems };
          },
          invalidCode: "storyboard_invalid",
        });
        ctx.log.info("storyboard written", { numTurns: step.numTurns });
        return { storyboard: step.value };
      });
    } catch (error) {
      throw toJobFailure(error);
    }
  };
}
