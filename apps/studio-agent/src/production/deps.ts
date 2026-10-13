import type { HandlerDeps } from "../jobs/index";
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

/** The production dependencies of a running agent. */
export function productionDeps(deps: HandlerDeps): ProducerStepDeps {
  const load = studio();
  return {
    workspaceRoot: deps.config.workspaceRoot,
    connect: mcpPlatformConnector(),
    studio: load,
    voiceKey: async () => (await load()).readVoiceProviderKey(),
    runtime: new SdkProducerRuntime({ protectedDirs: [deps.paths.home], log: deps.log }),
    log: deps.log,
  };
}
