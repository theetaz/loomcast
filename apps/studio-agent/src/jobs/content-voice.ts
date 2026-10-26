import type { ContentVoiceResult } from "@loomcast/contracts";
import { type Handler, JobFailure } from "../handlers";
import {
  loadVersion,
  type ProductionDeps,
  ProgressReporter,
  parsePayload,
  toJobFailure,
  withPlatform,
} from "../production/context";
import { productionDeps } from "../production/deps";
import { assetProbe, uploadFile } from "../production/upload";
import {
  ensureItemWorkspace,
  writeJsonAtomic,
  writeVersionArtifacts,
} from "../production/workspace";
import type { HandlerDeps } from "./index";

export function createContentVoiceHandler(deps: HandlerDeps): Handler<"content.voice"> {
  return voiceHandler(productionDeps(deps));
}

/** The failure for a Mac without a TTS provider key. */
export function voiceKeyMissing(): JobFailure {
  return new JobFailure(
    "voice_provider_key_missing",
    "No TTS provider key is set on this Mac; run `studio-agent secrets set voice-provider-key`",
    false,
  );
}

/**
 * `content.voice`: synthesizes the version's script with the TTS provider through the studio
 * runtime. No producer session takes part.
 *
 * 1. The script's segments are synthesized into `voice.mp3` with word timings
 *    (`alignment.json`), reporting progress every 10%.
 * 2. The take is measured with ffprobe and uploaded as a `voice` asset, finalized with the probe
 *    and the alignment, so the server stores the word timings with it.
 *
 * The key is read from the agent's secrets file (or the studio's environment) when the job runs.
 * It goes to the TTS provider only: never into an event, a result or a log line.
 */
export function voiceHandler(deps: ProductionDeps): Handler<"content.voice"> {
  return async (ctx): Promise<ContentVoiceResult> => {
    const payload = parsePayload(ctx);
    ctx.emit("status", { state: "starting" });
    const apiKey = await deps.voiceKey();
    if (apiKey === undefined || apiKey.length === 0) {
      throw voiceKeyMissing();
    }
    try {
      return await withPlatform(ctx, deps.connect, async (platform) => {
        const { item, version } = await loadVersion(platform, payload);
        const { script } = version;
        if (script === null) {
          throw new JobFailure("missing_artifact", "The version has no script to voice");
        }
        const workspace = await ensureItemWorkspace(
          deps.workspaceRoot,
          payload.workspaceId,
          item.id,
          version.versionNo,
        );
        await writeVersionArtifacts(workspace.version, version);
        const studio = await deps.studio();

        const progress = new ProgressReporter((state, value) =>
          ctx.emit("status", { state, progress: value }),
        );
        progress.report("synthesizing", 0);
        const voice = await studio.synthesizeVoice({
          apiKey,
          voiceId: payload.voice.voiceId,
          ...(payload.voice.speed === undefined ? {} : { speed: payload.voice.speed }),
          segments: script.segments.map((segment) => ({ id: segment.id, text: segment.text })),
          outputPath: workspace.version.voice,
          signal: ctx.signal,
          onProgress: (fraction) => progress.report("synthesizing", fraction),
        });
        await writeJsonAtomic(workspace.version.alignment, voice.alignment);
        const probe = await studio.probeMedia(voice.path, { signal: ctx.signal });
        const durationMs = Math.round(voice.durationMs > 0 ? voice.durationMs : probe.durationMs);
        if (durationMs < 1) {
          throw new JobFailure("voice_empty", "The synthesized voice take has no length");
        }

        ctx.emit("status", { state: "uploading" });
        const { asset } = await uploadFile({
          platform,
          itemId: item.id,
          kind: "voice",
          path: voice.path,
          mime: "audio/mpeg",
          filename: `voice-v${version.versionNo}.mp3`,
          probe: assetProbe(probe),
          alignment: voice.alignment,
          signal: ctx.signal,
          fetch: deps.fetch,
          sleep: deps.sleep,
        });
        ctx.log.info("voice take uploaded", {
          assetId: asset.id,
          durationMs,
          parts: voice.parts,
          words: voice.alignment.words.length,
        });
        return { voiceAssetId: asset.id, durationMs, alignment: voice.alignment };
      });
    } catch (error) {
      throw toJobFailure(error, "voice_failed");
    }
  };
}
