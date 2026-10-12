#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startAgent } from "./agent";
import { AGENT_VERSION, detectPlatform } from "./agent-info";
import { configIsShared, loadConfig, redactConfig } from "./config";
import { createHandlers } from "./jobs";
import { createLogger, isLogLevel, LOG_LEVELS } from "./logger";
import { pairDevice } from "./pair";
import { resolveAgentPaths } from "./paths";

/** Where a command writes its output; replaced in tests. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
}

const USAGE = `Usage: studio-agent <command> [options]

Commands:
  pair --server <url> --code <code> [--name <name>]
                         Pair this Mac with a Loomcast server
  run [--log-level <level>]
                         Connect to the server and run jobs until stopped
  status                 Show the configuration (the device token is redacted)

Options:
  -h, --help             Show this help
  -v, --version          Show the version
`;

type Command = (args: readonly string[], io: CliIo) => Promise<number>;

const commands: Readonly<Record<string, Command>> = {
  pair: pairCommand,
  run: runCommand,
  status: statusCommand,
};

/** Runs one CLI invocation and returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "-h" || name === "--help" || name === "help") {
    io.stdout(USAGE);
    return name === undefined ? 1 : 0;
  }
  if (name === "-v" || name === "--version") {
    io.stdout(`${AGENT_VERSION}\n`);
    return 0;
  }
  const command = commands[name];
  if (command === undefined) {
    io.stderr(`Unknown command "${name}".\n\n${USAGE}`);
    return 1;
  }
  try {
    return await command(rest, io);
  } catch (error) {
    io.stderr(`studio-agent ${name}: ${(error as Error).message}\n`);
    return 1;
  }
}

async function pairCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      server: { type: "string" },
      code: { type: "string" },
      name: { type: "string" },
    },
    strict: true,
  });
  if (values.server === undefined || values.code === undefined) {
    io.stderr("Usage: studio-agent pair --server <url> --code <code> [--name <name>]\n");
    return 1;
  }
  const paths = resolveAgentPaths(io.env);
  const config = await pairDevice(
    { server: values.server, code: values.code, name: values.name ?? hostname() },
    paths,
  );
  io.stdout(
    `Paired with ${config.serverUrl} as device ${config.deviceId}.\n` +
      `The device token is stored in ${paths.configFile}.\n` +
      "Start the agent with `studio-agent run`, or restart the service if it is installed.\n",
  );
  return 0;
}

/** Log level of `run` when `--log-level` is not given. */
const LOG_LEVEL_ENV = "LOOMCAST_AGENT_LOG_LEVEL";

async function runCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { "log-level": { type: "string" } },
    strict: true,
  });
  const level = values["log-level"] ?? io.env[LOG_LEVEL_ENV] ?? "info";
  if (!isLogLevel(level)) {
    io.stderr(`Unknown log level "${level}"; use one of ${LOG_LEVELS.join(", ")}.\n`);
    return 1;
  }
  const paths = resolveAgentPaths(io.env);
  const config = loadConfig(paths);
  if (config === null) {
    io.stderr("This Mac is not paired. Run `studio-agent pair --server <url> --code <code>`.\n");
    return 1;
  }
  const log = createLogger({ level, write: io.stderr });
  const handlers = await createHandlers({ config, paths, log });
  const agent = startAgent({ config, paths, handlers, log });

  const onSignal = (signal: NodeJS.Signals): void => {
    log.info("stopping", { signal });
    void agent.stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const reason = await agent.done;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  log.info("studio agent stopped", { reason });
  // Every stop reason is final: restarting cannot fix a revoked token or a superseded connection,
  // so the exit is clean and launchd does not restart the agent.
  return 0;
}

async function statusCommand(args: readonly string[], io: CliIo): Promise<number> {
  parseArgs({ args: [...args], options: {}, strict: true });
  const paths = resolveAgentPaths(io.env);
  io.stdout(`Loomcast studio agent ${AGENT_VERSION} (${detectPlatform()})\n`);
  io.stdout(`Config: ${paths.configFile}\n`);
  const config = loadConfig(paths);
  if (config === null) {
    io.stdout("Status: not paired. Run `studio-agent pair --server <url> --code <code>`.\n");
    return 0;
  }
  io.stdout(`Status: paired\n${JSON.stringify(redactConfig(config), null, 2)}\n`);
  if (configIsShared(paths)) {
    io.stderr(`Warning: ${paths.configFile} is readable by other users; run chmod 600 on it.\n`);
  }
  return 0;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
  };
  process.exitCode = await runCli(process.argv.slice(2), io);
}
