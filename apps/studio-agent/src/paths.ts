import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Overrides the agent's state directory. Tests point it at a temporary directory. */
export const AGENT_HOME_ENV = "LOOMCAST_AGENT_HOME";

/** Where the studio agent keeps its configuration and job state. */
export interface AgentPaths {
  /** The state directory (mode 0700). */
  readonly home: string;
  /** Server URL, device id and device token (mode 0600). */
  readonly configFile: string;
  /** One `<jobId>.jsonl` file of durable events per unsettled job. */
  readonly outboxDir: string;
  /** Outcomes of finished jobs, for idempotent re-assignment. */
  readonly journalFile: string;
}

export function resolveAgentPaths(env: NodeJS.ProcessEnv = process.env): AgentPaths {
  const override = env[AGENT_HOME_ENV];
  const home =
    override && override.length > 0
      ? resolve(override)
      : join(homedir(), ".config", "loomcast-agent");
  return {
    home,
    configFile: join(home, "config.json"),
    outboxDir: join(home, "outbox"),
    journalFile: join(home, "journal.jsonl"),
  };
}
