import type { SystemPingResult } from "@loomcast/contracts";
import { AGENT_VERSION, detectPlatform } from "../agent-info";
import type { Handler } from "../handlers";

export interface SystemPingOptions {
  /** Whether a `producer.chat` handler is registered. */
  readonly producerAvailable: () => boolean;
}

/** `system.ping`: reports the agent version, the Node runtime and whether producing is possible. */
export function createSystemPingHandler(options: SystemPingOptions): Handler<"system.ping"> {
  return async (ctx): Promise<SystemPingResult> => {
    ctx.emit("status", { state: "running" });
    return {
      agentVersion: AGENT_VERSION,
      runtime: { node: process.version, platform: detectPlatform() },
      producerAvailable: options.producerAvailable(),
    };
  };
}
