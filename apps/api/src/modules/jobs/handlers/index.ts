import type { Database } from "@loomcast/db";
import type { EventBus, Unsubscribe } from "../../../lib/bus";
import type { JobHooks } from "../hooks";
import { createKbAnalyzeReferenceHooks } from "./kb-analyze-reference";
import { createProducerChatHooks } from "./producer-chat";

export { createKbAnalyzeReferenceHooks } from "./kb-analyze-reference";
export { createProducerChatHooks } from "./producer-chat";

export interface JobHandlerDeps {
  db: Database;
  bus: EventBus;
}

/**
 * The job-type hook registry: one entry per job type with side effects. `createApp` passes it to
 * every job lifecycle through `ModuleDeps.hooks`; a new job type adds its handler file here.
 */
export function createJobHooks(deps: JobHandlerDeps): JobHooks {
  return {
    "producer.chat": createProducerChatHooks(deps),
    "kb.analyze_reference": createKbAnalyzeReferenceHooks(deps),
  };
}

/**
 * Runs each type's `onStatusChanged` hook for every `job.updated` event, that is after a status
 * change committed. Returns the unsubscribe function. A failing hook is logged by the bus.
 */
export function subscribeJobStatusHooks(bus: EventBus, hooks: JobHooks): Unsubscribe {
  return bus.subscribe("job.updated", async (event) => {
    const { job } = event.payload;
    await hooks[job.type]?.onStatusChanged?.(job);
  });
}
