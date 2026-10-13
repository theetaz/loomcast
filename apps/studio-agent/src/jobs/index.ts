import type { JobType } from "@loomcast/contracts";
import type { AgentConfig } from "../config";
import { type Handler, HandlerRegistry } from "../handlers";
import type { Logger } from "../logger";
import type { AgentPaths } from "../paths";
import { createSystemPingHandler } from "./system-ping";

/** What a handler factory may use. */
export interface HandlerDeps {
  readonly config: AgentConfig;
  readonly paths: AgentPaths;
  readonly log: Logger;
}

export type HandlerFactory<T extends JobType> = (deps: HandlerDeps) => Handler<T>;

export interface OptionalHandler {
  readonly type: JobType;
  readonly install: (registry: HandlerRegistry, deps: HandlerDeps) => Promise<void>;
}

/** A handler whose module is imported at start-up; a failing import only disables that type. */
export function optionalHandler<T extends JobType>(
  type: T,
  load: () => Promise<HandlerFactory<T>>,
): OptionalHandler {
  return {
    type,
    install: async (registry, deps) => {
      registry.register(type, (await load())(deps));
    },
  };
}

/** Handlers loaded behind a guard, so a broken producer runtime never takes `system.ping` down. */
const optionalHandlers: readonly OptionalHandler[] = [
  optionalHandler(
    "producer.chat",
    async () => (await import("./producer-chat")).createProducerChatHandler,
  ),
  optionalHandler(
    "kb.analyze_reference",
    async () => (await import("./kb-analyze-reference")).createKbAnalyzeReferenceHandler,
  ),
  optionalHandler(
    "content.write_script",
    async () => (await import("./content-write-script")).createContentWriteScriptHandler,
  ),
  optionalHandler(
    "content.storyboard",
    async () => (await import("./content-storyboard")).createContentStoryboardHandler,
  ),
  optionalHandler(
    "content.revise",
    async () => (await import("./content-revise")).createContentReviseHandler,
  ),
  optionalHandler(
    "content.voice",
    async () => (await import("./content-voice")).createContentVoiceHandler,
  ),
  optionalHandler(
    "content.render",
    async () => (await import("./content-render")).createContentRenderHandler,
  ),
];

/** Builds the fixed allow-list of job handlers. Nothing else can run on this agent. */
export async function createHandlers(
  deps: HandlerDeps,
  optional: readonly OptionalHandler[] = optionalHandlers,
): Promise<HandlerRegistry> {
  const registry = new HandlerRegistry();
  for (const handler of optional) {
    try {
      await handler.install(registry, deps);
    } catch (error) {
      deps.log.warn("job handler unavailable; not advertising it", {
        jobType: handler.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  registry.register(
    "system.ping",
    createSystemPingHandler({ producerAvailable: () => registry.has("producer.chat") }),
  );
  return registry;
}
