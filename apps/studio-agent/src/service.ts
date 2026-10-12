import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_HOME_ENV } from "./paths";

/** The launchd label, also the plist file name. */
export const SERVICE_LABEL = "com.loomcast.studio-agent";

const LAUNCHCTL = "/bin/launchctl";

/** Runs a fixed program with fixed arguments; never through a shell. */
export type ExecFn = (file: string, args: readonly string[]) => Promise<ExecResult>;

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ServiceEnvironment {
  readonly platform: NodeJS.Platform;
  /** The user's home directory. */
  readonly homeDir: string;
  readonly uid: number;
  /** Absolute path of the Node binary launchd starts. */
  readonly nodePath: string;
  /** Absolute path of the built `cli.mjs`. */
  readonly cliPath: string;
  /** Passed to the service as `LOOMCAST_AGENT_HOME` when set. */
  readonly agentHome?: string;
  readonly exec: ExecFn;
}

export interface ServicePaths {
  readonly plist: string;
  readonly logDir: string;
  readonly logFile: string;
}

export function servicePaths(homeDir: string): ServicePaths {
  const logDir = join(homeDir, "Library", "Logs", "Loomcast");
  return {
    plist: join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    logDir,
    logFile: join(logDir, "studio-agent.log"),
  };
}

/** The service environment of the current process. */
export function currentServiceEnvironment(env: NodeJS.ProcessEnv): ServiceEnvironment {
  return {
    platform: process.platform,
    homeDir: homedir(),
    uid: process.getuid?.() ?? -1,
    nodePath: process.execPath,
    // `../dist/cli.mjs` resolves to the bundle both from `src/service.ts` and from `dist/cli.mjs`.
    cliPath: fileURLToPath(new URL("../dist/cli.mjs", import.meta.url)),
    agentHome: env[AGENT_HOME_ENV] || undefined,
    exec: execNoShell,
  };
}

/** Thrown when the service cannot be managed; the message is meant for the user. */
export class ServiceError extends Error {
  override readonly name = "ServiceError";
}

export interface PlistOptions {
  readonly nodePath: string;
  readonly cliPath: string;
  readonly logFile: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * The launch agent definition. `KeepAlive.SuccessfulExit = false` restarts the agent after a crash
 * but not after a clean exit, which is how it stops when the device must be re-paired or another
 * connection replaced it; restarting would only repeat the refusal.
 */
export function buildPlist(options: PlistOptions): string {
  const environment = Object.entries(options.environment)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.nodePath)}</string>
    <string>${xml(options.cliPath)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(options.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(options.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.logFile)}</string>
</dict>
</plist>
`;
}

/** Writes the launch agent and (re)loads it with `launchctl bootstrap gui/<uid>`. */
export async function installService(env: ServiceEnvironment): Promise<ServicePaths> {
  assertMac(env);
  for (const path of [env.nodePath, env.cliPath]) {
    if (!isAbsolute(path)) {
      throw new ServiceError(`${path} is not an absolute path`);
    }
  }
  if (!existsSync(env.cliPath)) {
    throw new ServiceError(
      `${env.cliPath} does not exist; build the studio agent first ` +
        "(pnpm --filter @loomcast/studio-agent build)",
    );
  }
  const paths = servicePaths(env.homeDir);
  mkdirSync(dirname(paths.plist), { recursive: true });
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  const environment: Record<string, string> = {
    PATH: [dirname(env.nodePath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(
      ":",
    ),
  };
  if (env.agentHome !== undefined) {
    environment[AGENT_HOME_ENV] = env.agentHome;
  }
  writeFileSync(
    paths.plist,
    buildPlist({
      nodePath: env.nodePath,
      cliPath: env.cliPath,
      logFile: paths.logFile,
      workingDirectory: env.homeDir,
      environment,
    }),
    { mode: 0o644 },
  );

  // Reinstalling replaces a loaded agent, so unload it first; "not loaded" is fine.
  await env.exec(LAUNCHCTL, ["bootout", serviceTarget(env)]);
  const result = await env.exec(LAUNCHCTL, ["bootstrap", domainTarget(env), paths.plist]);
  if (result.code !== 0) {
    throw new ServiceError(`launchctl bootstrap failed: ${launchctlMessage(result)}`);
  }
  return paths;
}

/** Unloads the launch agent and deletes its plist. Logs are kept. */
export async function uninstallService(env: ServiceEnvironment): Promise<boolean> {
  assertMac(env);
  const paths = servicePaths(env.homeDir);
  const result = await env.exec(LAUNCHCTL, ["bootout", serviceTarget(env)]);
  const existed = existsSync(paths.plist);
  rmSync(paths.plist, { force: true });
  return existed || result.code === 0;
}

export interface ServiceStatus {
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly state?: string;
  readonly pid?: number;
  readonly lastExitCode?: string;
  readonly paths: ServicePaths;
}

/** Whether the plist exists and what `launchctl print` says about the loaded agent. */
export async function serviceStatus(env: ServiceEnvironment): Promise<ServiceStatus> {
  assertMac(env);
  const paths = servicePaths(env.homeDir);
  const installed = existsSync(paths.plist);
  const result = await env.exec(LAUNCHCTL, ["print", serviceTarget(env)]);
  if (result.code !== 0) {
    return { installed, loaded: false, paths };
  }
  const pid = field(result.stdout, "pid");
  return {
    installed,
    loaded: true,
    state: field(result.stdout, "state"),
    pid: pid === undefined ? undefined : Number(pid),
    lastExitCode: field(result.stdout, "last exit code"),
    paths,
  };
}

function assertMac(env: ServiceEnvironment): void {
  if (env.platform !== "darwin") {
    throw new ServiceError("The launchd service is only available on macOS");
  }
  if (env.uid < 0) {
    throw new ServiceError("Could not determine the user id");
  }
}

function domainTarget(env: ServiceEnvironment): string {
  return `gui/${env.uid}`;
}

function serviceTarget(env: ServiceEnvironment): string {
  return `${domainTarget(env)}/${SERVICE_LABEL}`;
}

/** Reads a top-level `name = value` line of `launchctl print` output. */
function field(output: string, name: string): string | undefined {
  const line = output
    .split("\n")
    .find((candidate) => candidate.match(/^\t[^\t]/) && candidate.trim().startsWith(`${name} =`));
  return line?.split("=").slice(1).join("=").trim();
}

function launchctlMessage(result: ExecResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`).slice(0, 500);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function execNoShell(file: string, args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { shell: false, timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}
