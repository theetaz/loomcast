import { copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AssetGetUrlOutput, ContentRenderResult } from "@loomcast/contracts";
import { type Handler, type JobContext, JobFailure } from "../handlers";
import {
  loadVersion,
  type ProductionDeps,
  ProgressReporter,
  parsePayload,
  toJobFailure,
  withPlatform,
} from "../production/context";
import { productionDeps } from "../production/deps";
import { assetProbe, downloadFile, sha256OfFile, uploadFile } from "../production/upload";
import {
  ensureItemWorkspace,
  type ItemWorkspace,
  versionLayout,
  writeJsonAtomic,
  writeVersionArtifacts,
} from "../production/workspace";
import type { HandlerDeps } from "./index";

export function createContentRenderHandler(deps: HandlerDeps): Handler<"content.render"> {
  return renderHandler(productionDeps(deps));
}

/**
 * `content.render`: renders the version's storyboard over its voice take with the studio runtime.
 * No producer session takes part, so a render is only ever produced here.
 *
 * 1. Checks the render tools (ffmpeg, ffprobe, the pinned HyperFrames CLI, GSAP and a browser
 *    already on this Mac). Nothing is downloaded; a missing tool fails the job.
 * 2. Gets the voice take: a local copy with the same SHA-256 from this item's folders, else a
 *    download through `asset.get_url`, checked against the checksum.
 * 3. Assembles and renders `out/final.mp4` and `poster.jpg`, reporting progress every 10%.
 * 4. Uploads the render and the poster, each finalized with its probe.
 */
export function renderHandler(deps: ProductionDeps): Handler<"content.render"> {
  return async (ctx): Promise<ContentRenderResult> => {
    const payload = parsePayload(ctx);
    ctx.emit("status", { state: "starting" });
    try {
      return await withPlatform(ctx, deps.connect, async (platform) => {
        const { item, version } = await loadVersion(platform, payload);
        const { script, storyboard } = version;
        if (script === null || storyboard === null) {
          throw new JobFailure(
            "missing_artifact",
            "The version needs a script and a storyboard to render",
          );
        }
        const studio = await deps.studio();
        const tools = await studio.checkRenderTools();
        if (!tools.ready) {
          const missing = [
            tools.ffmpeg ? undefined : "ffmpeg",
            tools.ffprobe ? undefined : "ffprobe",
            tools.hyperframes ? undefined : "the pinned HyperFrames CLI",
            tools.gsap ? undefined : "GSAP",
            tools.browser === undefined ? "a render browser" : undefined,
          ].filter((tool) => tool !== undefined);
          throw new JobFailure(
            "render_tools_missing",
            `This Mac cannot render: missing ${missing.join(", ")}`,
            false,
          );
        }

        const workspace = await ensureItemWorkspace(
          deps.workspaceRoot,
          payload.projectId,
          item.id,
          version.versionNo,
        );
        await writeVersionArtifacts(workspace.version, version);

        const voiceInfo = await platform.getAssetUrl({ assetId: payload.voiceAssetId });
        const voiceAsset = voiceInfo.asset;
        if (
          voiceAsset.kind !== "voice" ||
          voiceAsset.status !== "ready" ||
          voiceAsset.itemId !== item.id
        ) {
          throw new JobFailure(
            "invalid_payload",
            "The voice take is not a ready voice asset of this item",
          );
        }
        ctx.emit("status", { state: "fetching_voice" });
        await ensureLocalVoice(ctx, deps, workspace, voiceInfo);
        if (voiceAsset.alignment !== null) {
          await writeJsonAtomic(workspace.version.alignment, voiceAsset.alignment);
        }

        const { captions } = payload.format.rules.visualTemplate;
        const progress = new ProgressReporter((state, value, message) =>
          ctx.emit("status", {
            state,
            progress: value,
            ...(message === undefined ? {} : { message }),
          }),
        );
        progress.report("rendering", 0, "assemble");
        const rendered = await studio.renderItem({
          itemDir: workspace.version.dir,
          storyboard,
          voicePath: workspace.version.voice,
          ...(voiceAsset.durationMs !== null && voiceAsset.durationMs > 0
            ? { voiceDurationMs: voiceAsset.durationMs }
            : {}),
          ...(captions.enabled && voiceAsset.alignment !== null
            ? { alignment: voiceAsset.alignment, captionStyle: captions.style }
            : {}),
          hook: script.hook,
          title: item.title,
          quality: "standard",
          ...(tools.browser === undefined ? {} : { browserPath: tools.browser }),
          signal: ctx.signal,
          onProgress: ({ stage, fraction }) => progress.report("rendering", fraction, stage),
        });
        const { render } = rendered;

        ctx.emit("status", { state: "uploading" });
        const videoProbe = await studio.probeMedia(render.outputPath, { signal: ctx.signal });
        const posterProbe = await studio.probeMedia(render.posterPath, { signal: ctx.signal });
        const common = {
          platform,
          itemId: item.id,
          signal: ctx.signal,
          fetch: deps.fetch,
          sleep: deps.sleep,
        } as const;
        const renderAsset = await uploadFile({
          ...common,
          kind: "render",
          path: render.outputPath,
          mime: "video/mp4",
          filename: `render-v${version.versionNo}.mp4`,
          probe: assetProbe(videoProbe),
        });
        const posterAsset = await uploadFile({
          ...common,
          kind: "poster",
          path: render.posterPath,
          mime: "image/jpeg",
          filename: `poster-v${version.versionNo}.jpg`,
          probe: assetProbe(posterProbe),
        });
        const durationMs = Math.max(1, Math.round(render.durationMs));
        ctx.log.info("render uploaded", {
          renderAssetId: renderAsset.asset.id,
          posterAssetId: posterAsset.asset.id,
          durationMs,
          sizeBytes: render.sizeBytes,
          lintFindings: render.lintFindings.length,
        });
        return {
          renderAssetId: renderAsset.asset.id,
          posterAssetId: posterAsset.asset.id,
          durationMs,
          width: render.width,
          height: render.height,
        };
      });
    } catch (error) {
      throw toJobFailure(error, "render_failed");
    }
  };
}

/**
 * Puts the voice take at `<version>/voice.mp3`. A file there, or `voice.mp3` of another version
 * of the item, is reused when its SHA-256 matches the asset's; otherwise the take is downloaded.
 */
async function ensureLocalVoice(
  ctx: JobContext<"content.render">,
  deps: ProductionDeps,
  workspace: ItemWorkspace,
  voice: AssetGetUrlOutput,
): Promise<void> {
  const target = workspace.version.voice;
  const expected = voice.asset.sha256.toLowerCase();
  const candidates = [target];
  try {
    for (const entry of await readdir(workspace.itemDir, { withFileTypes: true })) {
      const path = versionLayout(join(workspace.itemDir, entry.name)).voice;
      if (entry.isDirectory() && /^v\d+$/.test(entry.name) && path !== target) {
        candidates.push(path);
      }
    }
  } catch {
    // No other versions on this Mac.
  }
  for (const candidate of candidates) {
    try {
      if ((await sha256OfFile(candidate)).sha256 === expected) {
        if (candidate !== target) {
          await copyFile(candidate, target);
        }
        ctx.log.info("using the local voice take", { reused: candidate !== target });
        return;
      }
    } catch {
      // Missing or unreadable; try the next one.
    }
  }
  await downloadFile({
    url: voice.url,
    path: target,
    sha256: expected,
    signal: ctx.signal,
    fetch: deps.fetch,
    sleep: deps.sleep,
  });
}
