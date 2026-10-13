import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/** The only tools a producer session can use (M1). Bash and everything else are denied. */
export const PRODUCER_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "WebSearch",
  "WebFetch",
] as const;
export type ProducerTool = (typeof PRODUCER_TOOLS)[number];

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
}

export function isProducerTool(name: string): name is ProducerTool {
  return (PRODUCER_TOOLS as readonly string[]).includes(name);
}

/**
 * The `canUseTool` guard of a producer session.
 *
 * - Allows only the producer tools; Bash and every other tool are denied with a reason.
 * - Write and Edit must target a path that resolves inside the workspace after `realpath`. For a
 *   new file the deepest existing ancestor is resolved, so a symlinked parent cannot escape, and
 *   paths with `..` segments or dangling symlinks are refused outright.
 * - Read, Glob and Grep may not touch the protected directories.
 */
export function createToolGuard(options: ToolGuardOptions): CanUseTool {
  return async (toolName, input) => checkToolUse(options, toolName, input);
}

export async function checkToolUse(
  options: ToolGuardOptions,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  if (!isProducerTool(toolName)) {
    return deny(`The ${toolName} tool is not available in a Loomcast producer session.`);
  }
  if (WRITE_TOOLS.has(toolName)) {
    return checkWrite(options, toolName, input);
  }
  if (READ_TOOLS.has(toolName)) {
    return checkRead(options, toolName, input);
  }
  return allow(input);
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
