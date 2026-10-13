import { type ChildProcess, spawn } from "node:child_process";

// Every external tool (the HyperFrames CLI, ffmpeg, ffprobe) runs through this module: argument
// arrays only, never a shell, and always with telemetry and self-update turned off.

/** Set on every spawned tool. The last two stop the HyperFrames CLI checking for or installing updates. */
export const TOOL_ENV: Readonly<Record<string, string>> = {
  HYPERFRAMES_NO_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  HYPERFRAMES_NO_AUTO_INSTALL: "1",
};

export function toolEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra, ...TOOL_ENV };
}

export interface RunOptions {
  cwd?: string;
  /** Extra environment variables; the tool flags in TOOL_ENV always win. */
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: Record<string, string>;
    shell: false;
    signal?: AbortSignal;
    stdio: ["ignore", "pipe", "pipe"];
    windowsHide: true;
  },
) => Pick<ChildProcess, "stdout" | "stderr" | "on">;

/** Output kept per stream: enough for JSON results and error tails, bounded for long renders. */
const MAX_CAPTURE = 4 * 1024 * 1024;

function append(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

/** Builds a runner around `spawn` (injectable for tests). */
export function createCommandRunner(spawnImpl: SpawnLike = spawn as SpawnLike): CommandRunner {
  return (command, args, options = {}) =>
    new Promise<RunResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawnImpl(command, [...args], {
        cwd: options.cwd,
        env: toolEnv(process.env, options.env),
        shell: false,
        signal: options.signal,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = append(stdout, chunk);
        options.onStdout?.(chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = append(stderr, chunk);
        options.onStderr?.(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          reject(new Error(`${command} is not installed or not on PATH`));
        else reject(error);
      });
      child.on("close", (code: number | null) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

export const runCommand: CommandRunner = createCommandRunner();

export class CommandError extends Error {
  readonly command: string;
  readonly code: number;
  readonly output: string;

  constructor(label: string, command: string, result: RunResult) {
    const tail = (result.stderr || result.stdout).trim().slice(-2_000);
    super(`${label} failed with exit code ${result.code}${tail ? `: ${tail}` : ""}`);
    this.name = "CommandError";
    this.command = command;
    this.code = result.code;
    this.output = tail;
  }
}

/** Runs a command and throws `CommandError` unless it exits 0. */
export async function runChecked(
  run: CommandRunner,
  label: string,
  command: string,
  args: readonly string[],
  options?: RunOptions,
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new CommandError(label, command, result);
  return result;
}
