import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  SKILL_MANIFEST_PATH,
  type SkillFile,
  type SkillKind,
  SkillManifestSchema,
} from "@loomcast/contracts";
import { createDb, users } from "@loomcast/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { loadRootEnv } from "../env";
import { createEventBus } from "../lib/bus";
import { HttpError } from "../lib/errors";
import { createLogger } from "../lib/logger";
import { createJobsService } from "../modules/jobs/service";
import { createSkillsService, type SkillActor } from "../modules/skills/service";
import type { CliDatabase } from "./admin";

const USAGE = `Usage:
  skills seed <dir> [--as <email>]

seed   Publishes every skill under <dir>: each directory with a skill.json manifest
       (name, kind, description) is one skill, with every file in it except dotfiles.
       Directories without a manifest are searched for skills one level further down
       (for example recipes/). Unchanged skills keep their current version. New versions
       queue a skills.sync job so studio agents pull them.
--as   The account the versions are published by and the sync jobs belong to.
       Defaults to the owner.

Reads DATABASE_URL from the environment or the repository's .env (outside production).`;

export interface SkillsCliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** A skill directory read from disk. */
export interface SkillSource {
  dir: string;
  name: string;
  kind: SkillKind;
  files: SkillFile[];
}

/** Every file under `dir` except dotfiles and dot-directories, as paths relative to `dir`. */
async function listFiles(dir: string, root = dir): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path, root)));
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join("/"));
  }
  return out;
}

/** Directories under `root` with a `skill.json`; a skill directory is not searched further. */
async function skillDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    const names = await readdir(dir);
    if (names.includes(SKILL_MANIFEST_PATH)) dirs.push(dir);
    else dirs.push(...(await skillDirs(dir)));
  }
  return dirs.sort();
}

/**
 * Reads the skills under `root`. The manifest gives each skill its name and kind; the files are
 * checked by the publish itself. Throws when a manifest is invalid or a name repeats.
 */
export async function readSkillSources(root: string): Promise<SkillSource[]> {
  const sources: SkillSource[] = [];
  const seen = new Map<string, string>();
  for (const dir of await skillDirs(root)) {
    const shown = relative(root, dir) || ".";
    let manifest: ReturnType<typeof SkillManifestSchema.parse>;
    try {
      manifest = SkillManifestSchema.parse(
        JSON.parse(await readFile(join(dir, SKILL_MANIFEST_PATH), "utf8")),
      );
    } catch (error) {
      throw new Error(`${shown}/${SKILL_MANIFEST_PATH} is not a valid manifest`, { cause: error });
    }
    const other = seen.get(manifest.name);
    if (other !== undefined) {
      throw new Error(`The skill ${manifest.name} is defined twice: in ${other} and ${shown}`);
    }
    seen.set(manifest.name, shown);
    const files: SkillFile[] = [];
    for (const path of await listFiles(dir)) {
      files.push({ path, content: await readFile(join(dir, ...path.split("/")), "utf8") });
    }
    sources.push({ dir: shown, name: manifest.name, kind: manifest.kind, files });
  }
  return sources;
}

/** The account named by `--as`, or the first owner. Null when there is none (no sync jobs then). */
async function publisher(database: CliDatabase, email: string | undefined) {
  const [row] = await database.db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(
        email === undefined ? eq(users.role, "owner") : eq(users.email, email.toLowerCase()),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(users.createdAt))
    .limit(1);
  return row ?? null;
}

function describe(error: unknown): string {
  if (error instanceof HttpError) {
    const details = Array.isArray(error.details)
      ? (error.details as { path?: string; message?: string }[])
          .map((issue) => `${issue.path ?? ""}: ${issue.message ?? ""}`)
          .join("; ")
      : "";
    return details === "" ? error.message : `${error.message} (${details})`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one skills command. Returns the exit code: 0 when every skill was published or unchanged,
 * 1 when any failed, 2 for a usage error.
 */
export async function runSkills(
  argv: readonly string[],
  io: SkillsCliIo,
  env: Record<string, string | undefined>,
  openDb: (databaseUrl: string) => CliDatabase,
): Promise<number> {
  let dir: string;
  let as: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      // `pnpm run skills:seed -- <dir>` may pass the separator through.
      args: argv.filter((arg) => arg !== "--"),
      allowPositionals: true,
      strict: true,
      options: { as: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
    const [command, target, ...rest] = positionals;
    if (values.help === true || command === undefined || command === "help") {
      io.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (command !== "seed" || target === undefined || rest.length > 0) {
      throw new Error(`Unknown command: ${positionals.join(" ")}`);
    }
    dir = resolve(target);
    as = values.as;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }

  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    io.stderr.write("DATABASE_URL must be a postgres:// URL.\n");
    return 1;
  }

  let sources: SkillSource[];
  try {
    sources = await readSkillSources(dir);
  } catch (error) {
    const cause =
      error instanceof Error && error.cause !== undefined ? `: ${describe(error.cause)}` : "";
    io.stderr.write(`${describe(error)}${cause}\n`);
    return 1;
  }
  if (sources.length === 0) {
    io.stderr.write(`No skill directories (with a ${SKILL_MANIFEST_PATH}) under ${dir}.\n`);
    return 1;
  }

  let database: CliDatabase | null = null;
  try {
    database = openDb(databaseUrl);
    const user = await publisher(database, as);
    if (as !== undefined && user === null) {
      io.stderr.write(`No enabled account has the email ${as}.\n`);
      return 1;
    }
    if (user === null) {
      io.stdout.write("No owner account yet: skills are published without sync jobs.\n");
    }
    const logger = createLogger({ level: "silent" });
    const bus = createEventBus(logger);
    const skills = createSkillsService({
      db: database.db,
      bus,
      jobs: createJobsService({ db: database.db, bus }),
      logger,
    });
    const actor: SkillActor = { kind: "system", id: null, userId: user?.id ?? null };

    let failed = 0;
    for (const source of sources) {
      try {
        const { version, created, restored, syncJobId } = await skills.publish(
          { name: source.name, kind: source.kind, files: source.files },
          actor,
        );
        const sync = syncJobId === null ? "" : `, sync job ${syncJobId}`;
        io.stdout.write(
          created
            ? `${source.name}: published version ${version.version} (${version.checksum})${sync}\n`
            : restored
              ? `${source.name}: restored version ${version.version} (${version.checksum})${sync}\n`
              : `${source.name}: unchanged at version ${version.version}\n`,
        );
      } catch (error) {
        failed += 1;
        io.stderr.write(`${source.name} (${source.dir}): ${describe(error)}\n`);
      }
    }
    io.stdout.write(`${sources.length - failed} of ${sources.length} skill(s) seeded.\n`);
    return failed === 0 ? 0 : 1;
  } catch (error) {
    io.stderr.write(`Failed: ${describe(error)}\n`);
    return 1;
  } finally {
    await database?.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  loadRootEnv();
  runSkills(process.argv.slice(2), process, process.env, (databaseUrl) =>
    createDb(databaseUrl, { max: 2 }),
  ).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
