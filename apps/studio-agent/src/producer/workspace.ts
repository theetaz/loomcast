import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IdSchema } from "@loomcast/contracts";

export const WORKSPACE_FILE = "PROJECT.md";

export interface WorkspaceWorkspace {
  /** `<workspaceRoot>/projects/<workspaceId>`, with symlinks resolved. */
  readonly dir: string;
  /** Whether this call created `PROJECT.md`. */
  readonly created: boolean;
}

/**
 * Ensures `<workspaceRoot>/projects/<workspaceId>/` exists and holds a `PROJECT.md` stub. The
 * directory is keyed by workspace id, not slug, so it stays the same when a workspace is renamed; the
 * producer runtime stores session transcripts per working directory. Existing files, including an
 * existing `PROJECT.md`, are never touched.
 */
export async function ensureWorkspaceWorkspace(
  workspaceRoot: string,
  workspaceId: string,
  workspaceName: string = workspaceId,
): Promise<WorkspaceWorkspace> {
  // The id becomes a path segment, so only a UUID is accepted.
  const id = IdSchema.parse(workspaceId);
  const dir = join(workspaceRoot, "projects", id);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  let created = true;
  try {
    await writeFile(join(dir, WORKSPACE_FILE), workspaceStub(workspaceName, id), { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    created = false;
  }
  return { dir: await realpath(dir), created };
}

function workspaceStub(name: string, id: string): string {
  return [
    `# ${name.replace(/[\r\n]+/g, " ").trim() || id}`,
    "",
    `Loomcast workspace \`${id}\`. The producer session works in this folder.`,
    "",
  ].join("\n");
}
