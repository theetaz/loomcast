import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The only shell commands a producer session may run, and only in a `content.storyboard`
 * session:
 *
 * - `npx hyperframes lint <path> [--json]` (or `hyperframes lint …`), which runs the studio's
 *   pinned HyperFrames CLI with node, never `npx`;
 * - `ffprobe -v error [options] <path>`.
 *
 * A command is split into plain tokens. Anything a shell would interpret (separators, pipes,
 * substitutions, redirections, globs, quotes, escapes, `~`, `!`, newlines) is refused before any
 * token is looked at. The path must resolve, after `realpath`, inside the item directory. An
 * allowed command is rewritten to absolute, quoted arguments with the telemetry variables set,
 * and that rewritten command is what runs. Everything else is denied with a reason.
 */
export interface CommandScope {
  /** `<workspaceRoot>/projects/<workspaceId>/items/<itemId>`: the only place commands may look. */
  readonly itemDir: string;
  /** The studio's pinned HyperFrames CLI (`studio/node_modules/hyperframes/bin/hyperframes.mjs`). */
  readonly hyperframesBin: string;
  /** Runs the CLI; defaults to the agent's own node. */
  readonly nodePath?: string;
  /** Defaults to `ffprobe` on the PATH. */
  readonly ffprobePath?: string;
}

/** Set on every allowed command, the same flags the studio runtime sets on its tools. */
export const COMMAND_ENV: Readonly<Record<string, string>> = {
  HYPERFRAMES_NO_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  HYPERFRAMES_NO_AUTO_INSTALL: "1",
};

export type CommandDecision =
  | {
      readonly ok: true;
      readonly kind: "lint" | "probe";
      /** The rewritten command that runs instead of the session's text. */
      readonly command: string;
      /** The resolved path the command reads. */
      readonly target: string;
    }
  | { readonly ok: false; readonly reason: string };

/** Shell metacharacters and other characters a command may never contain. */
const FORBIDDEN = /[;&|$`<>(){}[\]*?~!#'"\\\n\r\0]/;
/** What each token may consist of once the forbidden characters are ruled out. */
const TOKEN = /^[A-Za-z0-9._/:=,+@%-]+$/;
const MAX_COMMAND_LENGTH = 2_000;

const ALLOWED =
  "Only `npx hyperframes lint <path>` and `ffprobe -v error … <path>` may run, with a path inside the item directory.";

/** `ffprobe` options that take no value. */
const PROBE_FLAGS = new Set([
  "-show_format",
  "-show_streams",
  "-show_error",
  "-count_frames",
  "-hide_banner",
]);

/** `ffprobe` options that take one value, with the values they accept. */
const PROBE_VALUES: ReadonlyMap<string, RegExp> = new Map([
  ["-select_streams", /^[avs](?::\d{1,2})?$/],
  ["-show_entries", /^[A-Za-z0-9_=,:]{1,200}$/],
  ["-of", /^(?:json|csv|flat|ini|default|compact)(?:=[A-Za-z0-9_=:]{1,60})?$/],
  ["-print_format", /^(?:json|csv|flat|ini|default|compact)(?:=[A-Za-z0-9_=:]{1,60})?$/],
]);

/**
 * Splits a command into plain tokens. Returns a reason instead when the text contains anything a
 * shell would interpret.
 */
export function tokenizeCommand(command: string): string[] | { reason: string } {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
    return { reason: "The command is empty or too long." };
  }
  const forbidden = FORBIDDEN.exec(command);
  if (forbidden !== null) {
    const shown = /[\n\r\0]/.test(forbidden[0]) ? "a line break" : `"${forbidden[0]}"`;
    return {
      reason: `The command contains ${shown}; separators, pipes, substitutions, redirections, globs and quotes are not allowed.`,
    };
  }
  const tokens = command.trim().split(/[ \t]+/);
  if (tokens.length === 0 || tokens[0] === "") {
    return { reason: "The command is empty." };
  }
  for (const token of tokens) {
    if (!TOKEN.test(token)) {
      return {
        reason: `The argument ${JSON.stringify(token)} contains characters that are not allowed.`,
      };
    }
  }
  return tokens;
}

/**
 * Checks one Bash command against the allow-list. `cwd` is the session's working directory, which
 * relative paths are resolved against.
 */
export async function checkCommand(
  command: string,
  scope: CommandScope,
  cwd: string,
): Promise<CommandDecision> {
  const tokens = tokenizeCommand(command);
  if (!Array.isArray(tokens)) {
    return deny(tokens.reason);
  }
  const words = tokens[0] === "npx" ? tokens.slice(1) : tokens;
  const [program] = words;
  if (program === "hyperframes") {
    return checkLint(words.slice(1), scope, cwd);
  }
  if (program === "ffprobe" && tokens[0] !== "npx") {
    return checkProbe(words.slice(1), scope, cwd);
  }
  return deny(`${JSON.stringify(program ?? "")} is not an allowed command.`);
}

async function checkLint(
  args: readonly string[],
  scope: CommandScope,
  cwd: string,
): Promise<CommandDecision> {
  const [subcommand, path, ...flags] = args;
  if (subcommand !== "lint") {
    return deny(
      `\`hyperframes ${subcommand ?? ""}\` is not allowed: producer sessions only lint, and never render.`,
    );
  }
  if (path === undefined || path.startsWith("-")) {
    return deny("`hyperframes lint` needs the path of a folder inside the item directory.");
  }
  if (flags.some((flag) => flag !== "--json") || flags.length > 1) {
    return deny("`hyperframes lint` takes only the `--json` option.");
  }
  if (!(await isFile(scope.hyperframesBin))) {
    return deny("The studio's pinned HyperFrames CLI is not installed on this Mac.");
  }
  const target = await resolveInside(path, scope, cwd, "directory");
  if (typeof target !== "string") {
    return deny(target.reason);
  }
  return {
    ok: true,
    kind: "lint",
    target,
    command: shellCommand([
      scope.nodePath ?? process.execPath,
      scope.hyperframesBin,
      "lint",
      target,
      "--json",
    ]),
  };
}

async function checkProbe(
  args: readonly string[],
  scope: CommandScope,
  cwd: string,
): Promise<CommandDecision> {
  if (args[0] !== "-v" || args[1] !== "error") {
    return deny("`ffprobe` must start with `-v error`.");
  }
  const rest = args.slice(2);
  const path = rest.at(-1);
  if (path === undefined || path.startsWith("-")) {
    return deny("`ffprobe` needs the path of a file inside the item directory, last.");
  }
  const options: string[] = [];
  for (let index = 0; index < rest.length - 1; index += 1) {
    const option = rest[index] ?? "";
    if (PROBE_FLAGS.has(option)) {
      options.push(option);
      continue;
    }
    const pattern = PROBE_VALUES.get(option);
    const value = rest[index + 1];
    if (pattern === undefined || value === undefined || index + 1 >= rest.length - 1) {
      return deny(`The ffprobe option ${JSON.stringify(option)} is not allowed.`);
    }
    if (!pattern.test(value)) {
      return deny(`The value ${JSON.stringify(value)} is not allowed for ${option}.`);
    }
    options.push(option, value);
    index += 1;
  }
  const target = await resolveInside(path, scope, cwd, "file");
  if (typeof target !== "string") {
    return deny(target.reason);
  }
  return {
    ok: true,
    kind: "probe",
    target,
    // `file:` keeps ffprobe from reading a protocol prefix out of the file name.
    command: shellCommand([
      scope.ffprobePath ?? "ffprobe",
      "-v",
      "error",
      ...options,
      `file:${target}`,
    ]),
  };
}

/**
 * Resolves `path` (relative to `cwd`) with `realpath` and checks that it exists, has the expected
 * type and lies inside the item directory (or is the item directory itself).
 */
async function resolveInside(
  path: string,
  scope: CommandScope,
  cwd: string,
  type: "file" | "directory",
): Promise<string | { reason: string }> {
  const outside = { reason: `The path ${path} is not inside the item directory ${scope.itemDir}.` };
  if (path.split("/").includes("..")) {
    return { reason: "Paths with `..` segments are not allowed." };
  }
  let root: string;
  let target: string;
  try {
    root = await realpath(scope.itemDir);
    target = await realpath(resolve(cwd, path));
  } catch {
    return { reason: `The path ${path} does not exist inside the item directory.` };
  }
  if (target !== root && !isInside(root, target)) {
    return outside;
  }
  const stats = await stat(target);
  if (type === "file" ? !stats.isFile() : !stats.isDirectory()) {
    return { reason: `The path ${path} is not a ${type}.` };
  }
  return target;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The telemetry variables, then every argument single-quoted for a POSIX shell. */
export function shellCommand(argv: readonly string[]): string {
  const env = Object.entries(COMMAND_ENV).map(([name, value]) => `${name}=${value}`);
  return [...env, ...argv.map(shellQuote)].join(" ");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function deny(reason: string): CommandDecision {
  return { ok: false, reason: `${reason} ${ALLOWED}` };
}
