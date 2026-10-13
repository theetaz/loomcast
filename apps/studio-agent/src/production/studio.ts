import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BundledSkill,
  CardRegistry,
  CatalogueEntry,
  MediaProbe,
  RenderItemOptions,
  RenderItemResult,
  RenderTools,
  StoryboardIssue,
  SynthesizeVoiceOptions,
  SynthesizeVoiceResult,
  TranscribeOptions,
  Transcript,
} from "@loomcast/studio/runtime";

/** Overrides where the studio workspace (`studio/`) is. */
export const STUDIO_ROOT_ENV = "LOOMCAST_STUDIO_ROOT";

/**
 * The parts of the studio runtime the production jobs use. Every path the runtime needs is
 * derived from `studioRoot`, which is passed explicitly because the agent bundle moves
 * `import.meta.url` away from the studio's sources. Tests replace the whole object, so no test
 * renders, synthesizes or transcribes for real.
 */
export interface StudioRuntime {
  readonly studioRoot: string;
  /** The studio's pinned HyperFrames CLI entry. */
  readonly hyperframesBin: string;
  loadRegistry(): CardRegistry;
  cardCatalogue(registry: CardRegistry, styleId: string): CatalogueEntry[];
  validateStoryboard(
    storyboard: unknown,
    registry: CardRegistry,
    options?: { voiceDurationMs?: number },
  ): StoryboardIssue[];
  synthesizeVoice(options: SynthesizeVoiceOptions): Promise<SynthesizeVoiceResult>;
  renderItem(options: RenderItemOptions): Promise<RenderItemResult>;
  probeMedia(path: string, options?: { signal?: AbortSignal }): Promise<MediaProbe>;
  transcribeMedia(options: TranscribeOptions): Promise<Transcript>;
  /** What a render needs on this Mac. Never downloads anything. */
  checkRenderTools(): Promise<RenderTools>;
  loadBundledSkills(): BundledSkill[];
  /** The TTS provider key from the environment or the studio's `.env`. */
  readVoiceProviderKey(): string | undefined;
}

/** Loads the studio runtime on first use; later calls share it. */
export type StudioLoader = () => Promise<StudioRuntime>;

/**
 * The studio workspace root: `LOOMCAST_STUDIO_ROOT`, else the `studio/` folder found by walking up
 * from this module (the source tree and the built bundle both live inside the repository).
 */
export function resolveStudioRoot(
  env: NodeJS.ProcessEnv = process.env,
  from: string = import.meta.url,
): string {
  const override = env[STUDIO_ROOT_ENV];
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  let dir = dirname(from.startsWith("file:") ? fileURLToPath(from) : from);
  for (;;) {
    for (const candidate of [dir, join(dir, "studio")]) {
      if (isStudioRoot(candidate)) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find the studio workspace; set ${STUDIO_ROOT_ENV} to the repository's studio folder`,
      );
    }
    dir = parent;
  }
}

function isStudioRoot(dir: string): boolean {
  return existsSync(join(dir, "style-library")) && existsSync(join(dir, "runtime"));
}

/** A loader that imports the studio runtime once and binds it to `studioRoot`. */
export function studioLoader(studioRoot?: string): StudioLoader {
  let loading: Promise<StudioRuntime> | undefined;
  return () => {
    loading ??= loadStudioRuntime(studioRoot ?? resolveStudioRoot()).catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
}

async function loadStudioRuntime(studioRoot: string): Promise<StudioRuntime> {
  const studio = await import("@loomcast/studio/runtime");
  const paths = studio.studioPaths(studioRoot);
  return {
    studioRoot: paths.root,
    hyperframesBin: paths.hyperframesBin,
    loadRegistry: () => studio.loadRegistry({ studioRoot: paths.root }),
    cardCatalogue: (registry, styleId) => studio.cardCatalogue(registry, styleId),
    validateStoryboard: (storyboard, registry, options) =>
      studio.validateStoryboard(storyboard, registry, options),
    synthesizeVoice: (options) => studio.synthesizeVoice(options),
    renderItem: (options) => studio.renderItem({ ...options, studioRoot: paths.root }),
    probeMedia: (path, options) => studio.probeMedia(path, options),
    transcribeMedia: (options) => studio.transcribeMedia(options),
    checkRenderTools: () => studio.checkRenderTools({ studioRoot: paths.root }),
    loadBundledSkills: () => studio.loadBundledSkills({ studioRoot: paths.root }),
    readVoiceProviderKey: () => studio.readVoiceProviderKey({ envFile: join(paths.root, ".env") }),
  };
}
