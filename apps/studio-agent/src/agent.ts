import { PROTOCOL_VERSION } from "@loomcast/contracts";
import { AGENT_VERSION, detectPlatform } from "./agent-info";
import type { BackoffPolicy } from "./backoff";
import type { AgentConfig } from "./config";
import { BridgeConnection, type StopReason } from "./connection";
import type { HandlerRegistry } from "./handlers";
import { Journal } from "./journal";
import type { Logger } from "./logger";
import { Outbox } from "./outbox";
import type { AgentPaths } from "./paths";
import { ensurePrivateDir } from "./private-fs";
import { type BridgeTransport, JobRunner, type RunnerOptions } from "./runner";
import { bridgeUrl } from "./server-url";

export interface AgentOptions {
  readonly config: AgentConfig;
  readonly paths: AgentPaths;
  readonly handlers: HandlerRegistry;
  readonly log: Logger;
  /** Timing overrides, used by tests. */
  readonly timings?: {
    readonly backoff?: BackoffPolicy;
    readonly deadServerMs?: number;
  } & Pick<RunnerOptions, "heartbeatMs" | "streamBatchMs" | "timeoutMs">;
}

export interface RunningAgent {
  readonly runner: JobRunner;
  readonly connection: BridgeConnection;
  /** Resolves when the connection stops for good; running jobs are aborted first. */
  readonly done: Promise<StopReason>;
  /** Aborts running jobs as interrupted, reports them if possible and disconnects. */
  stop(): Promise<StopReason>;
}

/** Wires the outbox, journal, job runner and bridge connection together and connects. */
export function startAgent(options: AgentOptions): RunningAgent {
  const { config, paths, log, timings = {} } = options;
  ensurePrivateDir(paths.home);
  const outbox = Outbox.open(paths.outboxDir, log);
  const journal = Journal.open(paths.journalFile, { log });

  let connection: BridgeConnection | null = null;
  const transport: BridgeTransport = {
    get ready() {
      return connection?.ready ?? false;
    },
    get bufferedAmount() {
      return connection?.bufferedAmount ?? 0;
    },
    send: (draft) => connection?.send(draft) ?? false,
  };
  const runner = new JobRunner({
    handlers: options.handlers,
    outbox,
    journal,
    transport,
    concurrency: config.concurrency,
    log,
    heartbeatMs: timings.heartbeatMs,
    streamBatchMs: timings.streamBatchMs,
    timeoutMs: timings.timeoutMs,
  });
  runner.recoverInterrupted();

  const bridge = new BridgeConnection({
    url: bridgeUrl(config.serverUrl),
    token: config.token,
    log,
    backoff: timings.backoff,
    deadServerMs: timings.deadServerMs,
    handlers: {
      hello: () => ({
        protocol: PROTOCOL_VERSION,
        agentVersion: AGENT_VERSION,
        platform: detectPlatform(),
        jobTypes: runner.jobTypes(),
        credits: runner.credits(),
        resume: runner.resume(),
      }),
      ready: () => runner.connected(),
      message: (message) => runner.handle(message),
      invalidFrame: (frame, failure) => runner.invalidFrame(frame, failure),
      disconnected: () => runner.disconnected(),
    },
  });
  connection = bridge;

  const done = bridge.done.then(async (reason) => {
    await runner.shutdown();
    return reason;
  });

  log.info("studio agent starting", {
    version: AGENT_VERSION,
    server: config.serverUrl,
    deviceId: config.deviceId,
    jobTypes: runner.jobTypes(),
  });
  bridge.start();

  return {
    runner,
    connection: bridge,
    done,
    stop: async () => {
      await runner.shutdown();
      bridge.stop();
      return done;
    },
  };
}
