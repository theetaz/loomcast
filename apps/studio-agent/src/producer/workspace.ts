import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IdSchema } from "@loomcast/contracts";

export const PROJECT_FILE = "PROJECT.md";

export interface ProjectWorkspace {
  /** `<workspaceRoot>/projects/<projectId>`, with symlinks resolved. */
  readonly dir: string;
  /** Whether this call created `PROJECT.md`. */
  readonly created: boolean;
}

/**
 * Ensures `<workspaceRoot>/projects/<projectId>/` exists and holds a `PROJECT.md` stub. The
 * directory is keyed by project id, not slug, so it stays the same when a project is renamed; the
 * producer runtime stores session transcripts per working directory. Existing files, including an
 * existing `PROJECT.md`, are never touched.
 */
export async function ensureProjectWorkspace(
  workspaceRoot: string,
  projectId: string,
  projectName: string = projectId,
): Promise<ProjectWorkspace> {
  // The id becomes a path segment, so only a UUID is accepted.
  const id = IdSchema.parse(projectId);
  const dir = join(workspaceRoot, "projects", id);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  let created = true;
  try {
    await writeFile(join(dir, PROJECT_FILE), projectStub(projectName, id), { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    created = false;
  }
  return { dir: await realpath(dir), created };
}

function projectStub(name: string, id: string): string {
  return [
    `# ${name.replace(/[\r\n]+/g, " ").trim() || id}`,
    "",
    `Loomcast project \`${id}\`. The producer session works in this folder.`,
    "",
  ].join("\n");
}
