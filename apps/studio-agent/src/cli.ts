#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startAgent } from "./agent";
import { AGENT_VERSION, detectPlatform } from "./agent-info";
import {
  configIsShared,
  isSecretName,
  loadConfig,
  readSecret,
  redactConfig,
  SECRET_NAMES,
  secretsFile,
  setSecret,
  unsetSecret,
} from "./config";
import { createHandlers } from "./jobs";
import { createLogger, isLogLevel, LOG_LEVELS } from "./logger";
import { pairDevice } from "./pair";
import { resolveAgentPaths } from "./paths";
import {
  currentServiceEnvironment,
  installService,
  type ServiceEnvironment,
  servicePaths,
  serviceStatus,
  uninstallService,
} from "./service";

/** Where a command writes its output; replaced in tests. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  /** Replaces the launchd environment in tests. */
  readonly service?: ServiceEnvironment;
  /**
   * Reads a secret value: hidden input on a terminal, else the first line of stdin. Secrets are
   * never taken from the command line, where they would show in the process list and history.
   */
  readonly readSecret?: (prompt: string) => Promise<string>;
}

const USAGE = `Usage: studio-agent <command> [options]

Commands:
  pair --server <url> --code <code> [--name <name>]
                         Pair this Mac with a Loomcast server
  run [--log-level <level>]
                         Connect to the server and run jobs until stopped
  status                 Show the configuration (the device token is redacted)
  service install|uninstall|status
                         Manage the launchd agent that keeps \`run\` going in the background
  secrets set|unset voice-provider-key
                         Store or remove the TTS provider key (read from stdin, never an argument)

Options:
  -h, --help             Show this help
  -v, --version          Show the version
`;

type Command = (args: readonly string[], io: CliIo) => Promise<number>;

const commands: Readonly<Record<string, Command>> = {
  pair: pairCommand,
  run: runCommand,
  secrets: secretsCommand,
  service: serviceCommand,
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
      "Start the agent with `studio-agent run`.\n",
  );
  const service = io.service ?? currentServiceEnvironment(io.env);
  if (existsSync(servicePaths(service.homeDir).plist)) {
    io.stdout(
      "The launchd service is installed; run `studio-agent service install` to restart it.\n",
    );
  }
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

const SERVICE_USAGE = "Usage: studio-agent service install|uninstall|status\n";

async function serviceCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    allowPositionals: true,
    strict: true,
  });
  const [action, ...extra] = positionals;
  const service = io.service ?? currentServiceEnvironment(io.env);
  if (extra.length > 0) {
    io.stderr(SERVICE_USAGE);
    return 1;
  }
  switch (action) {
    case "install": {
      if (loadConfig(resolveAgentPaths(io.env)) === null) {
        io.stderr("Pair this Mac before installing the service (`studio-agent pair`).\n");
        return 1;
      }
      const paths = await installService(service);
      io.stdout(
        `Installed and started the studio agent service.\nPlist: ${paths.plist}\nLog: ${paths.logFile}\n`,
      );
      return 0;
    }
    case "uninstall": {
      const removed = await uninstallService(service);
      io.stdout(
        removed
          ? "Stopped and removed the studio agent service.\n"
          : "The service is not installed.\n",
      );
      return 0;
    }
    case "status": {
      const status = await serviceStatus(service);
      io.stdout(
        `Plist: ${status.paths.plist} (${status.installed ? "installed" : "not installed"})\n`,
      );
      io.stdout(`Log: ${status.paths.logFile}\n`);
      if (!status.loaded) {
        io.stdout("Service: not loaded\n");
        return 0;
      }
      io.stdout(`Service: loaded, state ${status.state ?? "unknown"}`);
      io.stdout(status.pid === undefined ? "\n" : `, pid ${status.pid}\n`);
      if (status.lastExitCode !== undefined) {
        io.stdout(`Last exit code: ${status.lastExitCode}\n`);
      }
      return 0;
    }
    default:
      io.stderr(SERVICE_USAGE);
      return 1;
  }
}

const SECRETS_USAGE = `Usage: studio-agent secrets set|unset <name>
Names: ${Object.keys(SECRET_NAMES).join(", ")}
The value is read from stdin (hidden on a terminal), for example:
  pbpaste | studio-agent secrets set voice-provider-key
`;

async function secretsCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    allowPositionals: true,
    strict: true,
  });
  const [action, name, ...extra] = positionals;
  if (name === undefined || !isSecretName(name) || extra.length > 0) {
    io.stderr(SECRETS_USAGE);
    return 1;
  }
  const paths = resolveAgentPaths(io.env);
  switch (action) {
    case "set": {
      const read = io.readSecret ?? readSecretFromStdin;
      const value = await read(`Enter the ${name}: `);
      setSecret(paths, name, value);
      io.stdout(`Stored the ${name} in ${secretsFile(paths)} (readable only by you).\n`);
      return 0;
    }
    case "unset":
      io.stdout(unsetSecret(paths, name) ? `Removed the ${name}.\n` : `The ${name} is not set.\n`);
      return 0;
    default:
      io.stderr(SECRETS_USAGE);
      return 1;
  }
}

/** A secret from stdin: typed without echo on a terminal, else the first line of piped input. */
async function readSecretFromStdin(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) {
      text += String(chunk);
      if (text.includes("\n") || text.length > 4_096) {
        break;
      }
    }
    return text.split(/\r?\n/)[0] ?? "";
  }
  const { createInterface } = await import("node:readline");
  const { Writable } = await import("node:stream");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) {
        stderr.write(chunk as Buffer);
      }
      done();
    },
  });
  const rl = createInterface({ input: stdin, output, terminal: true });
  stderr.write(prompt);
  muted = true;
  try {
    return await new Promise<string>((resolve) => rl.question("", resolve));
  } finally {
    rl.close();
    stderr.write("\n");
  }
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
  io.stdout(
    `Voice provider key: ${readSecret(paths, "voice-provider-key") === undefined ? "not set" : "set"}\n`,
  );
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
