import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { type CommandScope, checkCommand } from "../production/command-guard";
import { allowedMcpTools, isMcpToolName, MCP_SERVER_NAME, type ProducerJobType } from "./mcp";

/**
 * The built-in tools a producer session can use at most. Everything else is denied, and Bash only
 * reaches a storyboard session, where the command guard limits it to two read-only commands.
 */
export const PRODUCER_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "WebSearch",
  "WebFetch",
  "Bash",
] as const;
export type ProducerTool = (typeof PRODUCER_TOOLS)[number];

/**
 * The built-in tools of each job type's session. A reference analysis reads an untrusted
 * transcript, so its session can only read and search inside the project workspace: it can neither
 * write files nor reach the web, which leaves an injected instruction no way to send data out. A
 * competitor report reads a competitor's captions and analyses, so it gets the same tools.
 * Production steps read knowledge-base entries, which are untrusted too, and return their work as
 * the reply, so they get the same read-only tools. A storyboard session may also run the two
 * allow-listed commands (lint and probe) on files of its item.
 */
export const BUILTIN_TOOLS = {
  "producer.chat": ["Read", "Glob", "Grep", "Write", "Edit", "WebSearch", "WebFetch"],
  "kb.analyze_reference": ["Read", "Glob", "Grep"],
  "kb.competitor_report": ["Read", "Glob", "Grep"],
  "content.write_script": ["Read", "Glob", "Grep"],
  "content.storyboard": ["Read", "Glob", "Grep", "Bash"],
  "content.revise": ["Read", "Glob", "Grep"],
} as const satisfies Record<ProducerJobType, readonly ProducerTool[]>;

const SESSION_LABELS: Record<ProducerJobType, string> = {
  "producer.chat": "Loomcast producer session",
  "kb.analyze_reference": "reference analysis session, which is read-only",
  "kb.competitor_report": "competitor report session, which is read-only",
  "content.write_script": "script session, which is read-only",
  "content.storyboard": "storyboard session, which is read-only",
  "content.revise": "revision session, which is read-only",
};

/** Sessions whose reads and searches may not leave the project workspace. */
const CONFINED_READ_JOBS: ReadonlySet<ProducerJobType> = new Set<ProducerJobType>([
  "kb.analyze_reference",
  "kb.competitor_report",
  "content.write_script",
  "content.storyboard",
  "content.revise",
]);

/** The longest a guarded command may run, in milliseconds. */
export const COMMAND_TIMEOUT_MS = 120_000;

/** Tools whose target path must resolve inside the project workspace. */
const WRITE_TOOLS: ReadonlySet<string> = new Set<ProducerTool>(["Write", "Edit"]);
/** Tools that read the filesystem; they may not look inside protected directories. */
const READ_TOOLS: ReadonlySet<string> = new Set<ProducerTool>(["Read", "Glob", "Grep"]);

export interface ToolGuardOptions {
  /** `<workspaceRoot>/projects/<projectId>`: the only place writes and edits may land. */
  readonly workspaceDir: string;
  /**
   * Directories no tool may read, such as the agent's state directory, which holds the device
   * token. Prompt-injected content must not be able to read a secret and send it out with WebFetch.
   */
  readonly protectedDirs?: readonly string[];
  /** The job the session runs for; it picks the tools. Defaults to `producer.chat`. */
  readonly jobType?: ProducerJobType;
  /**
   * Where the allow-listed commands may look, and the pinned CLI they run. Without it, Bash is
   * denied even in a storyboard session.
   */
  readonly commandScope?: CommandScope;
}

/** Where an MCP tool comes from, as the runtime reports it to the permission callback. */
export interface McpToolOrigin {
  readonly name: string;
  readonly source: string;
}

export function isProducerTool(name: string): name is ProducerTool {
  return (PRODUCER_TOOLS as readonly string[]).includes(name);
}

/** The built-in tools a job type's session gets. */
export function builtinToolsFor(jobType: ProducerJobType): readonly ProducerTool[] {
  return BUILTIN_TOOLS[jobType];
}

/** The producer tools a job type's session does not get; they are removed from the session. */
export function deniedBuiltinTools(jobType: ProducerJobType): ProducerTool[] {
  const allowed: readonly string[] = builtinToolsFor(jobType);
  return PRODUCER_TOOLS.filter((tool) => !allowed.includes(tool));
}

/**
 * The `canUseTool` guard of a producer session.
 *
 * - Allows only the built-in tools of the job type; Bash and every other tool are denied with a
 *   reason.
 * - Allows only the platform MCP tools on the job type's allow-list; every other MCP tool and
 *   every other MCP server is denied.
 * - Write and Edit must target a path that resolves inside the workspace after `realpath`. For a
 *   new file the deepest existing ancestor is resolved, so a symlinked parent cannot escape, and
 *   paths with `..` segments or dangling symlinks are refused outright.
 * - Read, Glob and Grep may not touch the protected directories. In a reference analysis and in
 *   production steps they may not leave the project workspace at all.
 * - Bash runs only in a storyboard session and only the allow-listed commands
 *   (`command-guard.ts`); the allowed command is replaced by its rewritten, absolute form.
 */
export function createToolGuard(options: ToolGuardOptions): CanUseTool {
  return async (toolName, input, context) =>
    checkToolUse(options, toolName, input, context?.mcpServer);
}

export async function checkToolUse(
  options: ToolGuardOptions,
  toolName: string,
  input: Record<string, unknown>,
  mcpServer?: McpToolOrigin,
): Promise<PermissionResult> {
  const jobType = options.jobType ?? "producer.chat";
  const label = SESSION_LABELS[jobType];
  if (isMcpToolName(toolName)) {
    return checkMcp(jobType, label, toolName, input, mcpServer);
  }
  if (!isProducerTool(toolName) || !builtinToolsFor(jobType).includes(toolName)) {
    return deny(`The ${toolName} tool is not available in a ${label}.`);
  }
  if (toolName === "Bash") {
    return checkBash(options, input);
  }
  if (WRITE_TOOLS.has(toolName)) {
    return checkWrite(options, toolName, input);
  }
  if (READ_TOOLS.has(toolName)) {
    return CONFINED_READ_JOBS.has(jobType)
      ? checkConfinedRead(options, toolName, input)
      : checkRead(options, toolName, input);
  }
  return allow(input);
}

/**
 * Bash: only the allow-listed commands, rewritten to absolute, quoted arguments with the telemetry
 * variables set. The rewritten input keeps only the command, a description and a bounded timeout,
 * so a session can neither run it in the background nor ask to leave a sandbox.
 */
async function checkBash(
  options: ToolGuardOptions,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  if (options.commandScope === undefined) {
    return deny("Commands are not available in this session.");
  }
  const command = input.command;
  if (typeof command !== "string") {
    return deny("Bash needs a command.");
  }
  const decision = await checkCommand(command, options.commandScope, options.workspaceDir);
  if (!decision.ok) {
    return deny(decision.reason);
  }
  const timeout =
    typeof input.timeout === "number" && input.timeout > 0
      ? Math.min(input.timeout, COMMAND_TIMEOUT_MS)
      : COMMAND_TIMEOUT_MS;
  return allow({
    command: decision.command,
    timeout,
    ...(typeof input.description === "string"
      ? { description: input.description.slice(0, 200) }
      : {}),
  });
}

function checkMcp(
  jobType: ProducerJobType,
  label: string,
  toolName: string,
  input: Record<string, unknown>,
  mcpServer: McpToolOrigin | undefined,
): PermissionResult {
  const fromPlatform = mcpServer === undefined || mcpServer.name === MCP_SERVER_NAME;
  if (fromPlatform && allowedMcpTools(jobType).includes(toolName)) {
    return allow(input);
  }
  return deny(`The ${toolName} MCP tool is not available in a ${label}.`);
}

async function checkWrite(
  options: ToolGuardOptions,
  tool: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  const path = input.file_path;
  const outside = `${tool} is allowed only inside the project workspace ${options.workspaceDir}.`;
  if (!isUsablePath(path)) {
    return deny(`${tool} needs a file path inside the project workspace.`);
  }
  if (hasParentSegment(path)) {
    return deny(`${outside} Paths with ".." segments are not allowed.`);
  }
  try {
    const root = await realpath(options.workspaceDir);
    const target = await resolveReal(resolve(root, path));
    return isStrictlyInside(root, target) ? allow(input) : deny(outside);
  } catch {
    return deny(outside);
  }
}

async function checkRead(
  options: ToolGuardOptions,
  tool: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  const path = tool === "Read" ? input.file_path : input.path;
  const protectedDirs = options.protectedDirs ?? [];
  if (path === undefined || protectedDirs.length === 0) {
    return allow(input);
  }
  if (!isUsablePath(path)) {
    return deny(`${tool} needs a valid path.`);
  }
  // Glob and Grep search below their path, so a parent of a protected directory is refused too.
  const searches = tool !== "Read";
  try {
    const target = await resolveReal(resolve(options.workspaceDir, path));
    for (const dir of protectedDirs) {
      const real = await resolveReal(resolve(dir));
      if (
        target === real ||
        isStrictlyInside(real, target) ||
        (searches && isStrictlyInside(target, real))
      ) {
        return deny(`${tool} may not read the studio agent's private files.`);
      }
    }
    return allow(input);
  } catch {
    return deny(`${tool} could not resolve ${path}.`);
  }
}

/**
 * Read, Glob and Grep of a reference analysis: the path must resolve inside the workspace (no
 * path means the workspace itself), and Glob and Grep patterns may be neither absolute nor contain
 * `..` segments.
 */
async function checkConfinedRead(
  options: ToolGuardOptions,
  tool: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  const outside = `${tool} is allowed only inside the project workspace ${options.workspaceDir}.`;
  const path = tool === "Read" ? input.file_path : input.path;
  for (const key of ["pattern", "glob"]) {
    const pattern = tool === "Read" ? undefined : input[key];
    if (typeof pattern === "string" && (isAbsolute(pattern) || hasParentSegment(pattern))) {
      return deny(outside);
    }
  }
  if (path === undefined && tool !== "Read") {
    return allow(input);
  }
  if (!isUsablePath(path) || hasParentSegment(path)) {
    return deny(outside);
  }
  try {
    const root = await realpath(options.workspaceDir);
    const target = await resolveReal(resolve(root, path));
    return target === root || isStrictlyInside(root, target) ? allow(input) : deny(outside);
  } catch {
    return deny(outside);
  }
}

function allow(input: Record<string, unknown>): PermissionResult {
  return { behavior: "allow", updatedInput: input };
}

function deny(message: string): PermissionResult {
  return { behavior: "deny", message };
}

function isUsablePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.includes("\0");
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]/).includes("..");
}

/** Whether `target` lies below `root` (and is not `root` itself). */
export function isStrictlyInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolves symlinks in `path`. When the path does not exist yet, the deepest existing ancestor is
 * resolved and the missing components are appended. A dangling symlink on the way is an error,
 * because writing through it would create its target, wherever that is.
 */
export async function resolveReal(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
      if (await exists(current)) {
        throw new Error(`${current} is a dangling symlink`);
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Whether a directory entry exists at `path`, without following a final symlink. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
