import { readSecret } from "../config";
import type { HandlerDeps } from "../jobs/index";
import type { AgentPaths } from "../paths";
import { SdkProducerRuntime } from "../producer/sdk-runtime";
import type { ProducerStepDeps } from "./context";
import { mcpPlatformConnector } from "./platform";
import { type StudioLoader, studioLoader } from "./studio";

/** One studio runtime per process, imported on first use. */
let sharedStudio: StudioLoader | undefined;

function studio(): StudioLoader {
  sharedStudio ??= studioLoader();
  return sharedStudio;
}

/**
 * The TTS provider key: the agent's secrets file first (`studio-agent secrets set
 * voice-provider-key`), then the environment and the studio's `.env`.
 */
export function voiceKeyReader(
  paths: AgentPaths,
  load: StudioLoader,
): () => Promise<string | undefined> {
  return async () =>
    readSecret(paths, "voice-provider-key") ?? (await load()).readVoiceProviderKey();
}

/** The production dependencies of a running agent. */
export function productionDeps(deps: HandlerDeps): ProducerStepDeps {
  const load = studio();
  return {
    workspaceRoot: deps.config.workspaceRoot,
    connect: mcpPlatformConnector(),
    studio: load,
    voiceKey: voiceKeyReader(deps.paths, load),
    runtime: new SdkProducerRuntime({ protectedDirs: [deps.paths.home], log: deps.log }),
    log: deps.log,
  };
}
