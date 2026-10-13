import { randomBytes } from "node:crypto";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { IdSchema } from "@loomcast/contracts";
import { ensureProjectWorkspace } from "../producer/workspace";

/**
 * The files of one content version in the workspace, the same layout the studio runtime's
 * `itemLayout` uses:
 *
 * `<workspaceRoot>/projects/<projectId>/items/<itemId>/v<n>/` holds `script.json`,
 * `storyboard.json`, `voice.mp3`, `alignment.json`, `render/`, `out/final.mp4` and `poster.jpg`.
 *
 * A job works in the folder of the version it starts from: it writes that version's artifacts
 * there and puts what it produces (a voice take, a render) next to them.
 */
export interface VersionLayout {
  readonly dir: string;
  readonly script: string;
  readonly storyboard: string;
  readonly voice: string;
  readonly alignment: string;
  readonly renderDir: string;
  readonly output: string;
  readonly poster: string;
}

export function versionLayout(dir: string): VersionLayout {
  return {
    dir,
    script: join(dir, "script.json"),
    storyboard: join(dir, "storyboard.json"),
    voice: join(dir, "voice.mp3"),
    alignment: join(dir, "alignment.json"),
    renderDir: join(dir, "render"),
    output: join(dir, "out", "final.mp4"),
    poster: join(dir, "poster.jpg"),
  };
}

export interface ItemWorkspace {
  /** `<workspaceRoot>/projects/<projectId>`, the producer session's working directory. */
  readonly projectDir: string;
  /** `<projectDir>/items/<itemId>`. */
  readonly itemDir: string;
  readonly version: VersionLayout;
}

/** Creates the folders of one content version and returns their paths, with symlinks resolved. */
export async function ensureItemWorkspace(
  workspaceRoot: string,
  projectId: string,
  itemId: string,
  versionNo: number,
): Promise<ItemWorkspace> {
  // Ids and the version number become path segments, so only valid ones are accepted.
  const item = IdSchema.parse(itemId);
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    throw new Error(`Invalid version number ${versionNo}`);
  }
  const project = await ensureProjectWorkspace(workspaceRoot, projectId);
  const itemDir = join(project.dir, "items", item);
  const versionDir = join(itemDir, `v${versionNo}`);
  await mkdir(versionDir, { recursive: true, mode: 0o755 });
  return {
    projectDir: project.dir,
    itemDir: await realpath(itemDir),
    version: versionLayout(await realpath(versionDir)),
  };
}

/** Writes JSON through a temporary file and a rename, so readers never see half a file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** Writes the script and storyboard a version has into its folder, for the session to read. */
export async function writeVersionArtifacts(
  layout: VersionLayout,
  version: { readonly script: unknown; readonly storyboard: unknown },
): Promise<void> {
  if (version.script !== null && version.script !== undefined) {
    await writeJsonAtomic(layout.script, version.script);
  }
  if (version.storyboard !== null && version.storyboard !== undefined) {
    await writeJsonAtomic(layout.storyboard, version.storyboard);
  }
}
