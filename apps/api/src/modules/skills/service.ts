import { createHash, randomUUID } from "node:crypto";
import {
  type ActorKind,
  SKILL_CHANGELOG_MAX_LENGTH,
  SKILL_MANIFEST_PATH,
  type SkillFile,
  SkillFilesSchema,
  type SkillKind,
  SkillKindSchema,
  SkillManifestSchema,
  SkillNameSchema,
  type SkillSummary,
  type SkillVersionDetail,
  type SkillVersionSummary,
  skillChecksumInput,
} from "@loomcast/contracts";
import {
  type Database,
  nextSkillVersion,
  projects,
  type SkillRow,
  type SkillVersionRow,
  skills,
  skillVersions,
} from "@loomcast/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, type Transaction, transaction } from "../../lib/db";
import { conflict, validationFailed } from "../../lib/errors";
import { issueDetails } from "../../lib/http";
import type { Logger } from "../../lib/logger";
import type { JobsService } from "../jobs/service";
import { toSkillSummary, toSkillVersionDetail, toSkillVersionSummary } from "./mappers";

/**
 * Who publishes a skill: a user's MCP token (`token`, `id` is the token), a signed-in user, or the
 * server itself (`system`, the seed command). `userId` is stored as `published_by_user` and owns
 * the `skills.sync` job; without one no sync job is queued.
 */
export interface SkillActor {
  kind: ActorKind;
  id: string | null;
  userId: string | null;
  ip?: string | null;
}

export interface PublishSkillInput {
  name: string;
  kind: SkillKind;
  files: SkillFile[];
  changelog?: string;
}

export interface PublishSkillResult {
  version: SkillVersionSummary;
  /**
   * False when the files matched a version the skill already has. That version is returned; when
   * it was not the current one it becomes current again (a rollback).
   */
  created: boolean;
  /** True when an earlier version became current again because its files were published. */
  restored: boolean;
  /** The `skills.sync` job queued for the change, or null when none was needed or possible. */
  syncJobId: string | null;
}

export interface SkillsService {
  /**
   * Publishes `files` as the next version of the skill `name`, creating the skill at version 1.
   * Files a version already has are not stored again: the current version is returned unchanged,
   * and an older one becomes current again. A new or restored current version publishes
   * `skill.published` and queues one `skills.sync` job (idempotency key `skills:<checksum>`) so
   * studio agents pull it.
   *
   * 400 `validation_failed` for an invalid name, kind, file set or `skill.json` (which, when
   * present, must name the same skill and kind). 409 `conflict` when the skill exists with another
   * kind.
   */
  publish(input: PublishSkillInput, actor: SkillActor): Promise<PublishSkillResult>;
  /** Every skill with its current version, by name. */
  list(): Promise<SkillSummary[]>;
  /** One version with its files: the current one, or `version`. Null when there is none. */
  get(name: string, version?: number): Promise<SkillVersionDetail | null>;
  /** Every version of a skill, newest first. Null for an unknown skill. */
  versions(name: string): Promise<SkillVersionSummary[] | null>;
  /** Every skill at its current version, with files, by name. */
  pullAll(): Promise<SkillVersionDetail[]>;
}

export interface SkillsServiceDeps {
  db: Database;
  bus: EventBus;
  jobs: Pick<JobsService, "enqueue">;
  logger: Logger;
}

/** SHA-256 (lowercase hex) of the UTF-8 bytes of `skillChecksumInput(files)`. */
export function skillChecksum(files: readonly SkillFile[]): string {
  return createHash("sha256").update(skillChecksumInput(files), "utf8").digest("hex");
}

const PublishSkillInputSchema = z.object({
  name: SkillNameSchema,
  kind: SkillKindSchema,
  files: SkillFilesSchema,
  changelog: z.string().trim().max(SKILL_CHANGELOG_MAX_LENGTH).optional(),
});

/** The input checked again (the CLI and other callers skip the MCP schema), with the manifest. */
function parsePublishInput(input: PublishSkillInput): z.output<typeof PublishSkillInputSchema> {
  const parsed = PublishSkillInputSchema.safeParse(input);
  if (!parsed.success) {
    throw validationFailed(issueDetails(parsed.error), "The skill is not valid.");
  }
  const { name, kind, files } = parsed.data;
  const index = files.findIndex((file) => file.path === SKILL_MANIFEST_PATH);
  const manifestFile = files[index];
  if (manifestFile !== undefined) {
    const path = `files.${index}.content`;
    let json: unknown;
    try {
      json = JSON.parse(manifestFile.content);
    } catch {
      throw validationFailed([{ path, message: "skill.json is not valid JSON" }]);
    }
    const manifest = SkillManifestSchema.safeParse(json);
    if (!manifest.success) {
      throw validationFailed(
        issueDetails(manifest.error).map((issue) => ({
          path: issue.path === "" ? path : `${path}.${issue.path}`,
          message: `skill.json: ${issue.message}`,
        })),
      );
    }
    if (manifest.data.name !== name || manifest.data.kind !== kind) {
      throw validationFailed([
        { path, message: "skill.json must name the same skill and kind as the publish" },
      ]);
    }
  }
  return parsed.data;
}

async function skillByName(executor: Executor, name: string): Promise<SkillRow | null> {
  if (!SkillNameSchema.safeParse(name).success) {
    return null;
  }
  const [row] = await executor.select().from(skills).where(eq(skills.name, name)).limit(1);
  return row ?? null;
}

async function versionById(executor: Executor, id: string): Promise<SkillVersionRow> {
  const [row] = await executor.select().from(skillVersions).where(eq(skillVersions.id, id));
  if (row === undefined) {
    throw new Error("skill without its current version");
  }
  return row;
}

/**
 * The project a `skills.sync` job is queued under. Skills are global, but every job belongs to a
 * project: the most recently updated active one. Null when there is none.
 */
async function syncProject(tx: Transaction): Promise<string | null> {
  const [row] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.status, "active"))
    .orderBy(desc(projects.updatedAt), asc(projects.id))
    .limit(1);
  return row?.id ?? null;
}

export function createSkillsService(deps: SkillsServiceDeps): SkillsService {
  const { db, bus, jobs } = deps;
  const log = deps.logger.child({ module: "skills" });

  /** Queues the sync of a new current version, when there is a user and a project to own it. */
  async function enqueueSync(
    tx: Transaction,
    name: string,
    idempotencyKey: string,
    actor: SkillActor,
  ): Promise<string | null> {
    if (actor.userId === null) {
      log.info({ skill: name }, "no user to own a skills.sync job; studio agents sync later");
      return null;
    }
    const projectId = await syncProject(tx);
    if (projectId === null) {
      log.info({ skill: name }, "no active project to queue skills.sync under");
      return null;
    }
    const { job } = await jobs.enqueue(tx, {
      type: "skills.sync",
      payload: { names: [name] },
      projectId,
      idempotencyKey,
      createdBy: actor.userId,
    });
    return job.id;
  }

  function announce(tx: Transaction, version: SkillVersionSummary): void {
    afterCommit(tx, () => bus.publish({ type: "skill.published", payload: { skill: version } }));
  }

  /** Inserts the skill and its version 1 (the current-version key is deferred). */
  async function createSkill(
    tx: Transaction,
    input: z.output<typeof PublishSkillInputSchema>,
    checksum: string,
    actor: SkillActor,
  ): Promise<{ skill: SkillRow; version: SkillVersionRow } | null> {
    const skillId = randomUUID();
    const versionId = randomUUID();
    const [skill] = await tx
      .insert(skills)
      .values({ id: skillId, name: input.name, kind: input.kind, currentVersionId: versionId })
      .onConflictDoNothing({ target: skills.name })
      .returning();
    if (skill === undefined) {
      // Published concurrently: the caller continues with the existing skill.
      return null;
    }
    const [version] = await tx
      .insert(skillVersions)
      .values({
        id: versionId,
        skillId,
        version: 1,
        files: input.files,
        checksum,
        changelog: input.changelog ?? null,
        publishedByUser: actor.userId,
        publishedByToken: actor.kind === "token" ? actor.id : null,
      })
      .returning();
    if (version === undefined) {
      throw new Error("skill version was not inserted");
    }
    return { skill, version };
  }

  return {
    async publish(input, actor) {
      const parsed = parsePublishInput(input);
      const checksum = skillChecksum(parsed.files);

      /** Audits the new current version, announces it and queues its sync. */
      async function finish(
        tx: Transaction,
        skill: SkillRow,
        version: SkillVersionRow,
        action: "skill.published" | "skill.restored",
        created: boolean,
      ): Promise<PublishSkillResult> {
        const summary = toSkillVersionSummary(skill, version);
        await audit(tx, {
          actorKind: actor.kind,
          actorId: actor.id,
          action,
          targetType: "skill",
          targetId: skill.id,
          data: { name: skill.name, version: version.version, checksum: version.checksum },
          ip: actor.ip ?? null,
        });
        // A restored version needs a sync of its own, even though its checksum was synced before.
        const key = created
          ? `skills:${version.checksum}`
          : `skills:${version.checksum}:restored:${randomUUID()}`;
        const syncJobId = await enqueueSync(tx, skill.name, key, actor);
        announce(tx, summary);
        return { version: summary, created, restored: !created, syncJobId };
      }

      return transaction(db, async (tx) => {
        const fresh = (await skillByName(tx, parsed.name)) === null;
        const created = fresh ? await createSkill(tx, parsed, checksum, actor) : null;
        if (created !== null) {
          return finish(tx, created.skill, created.version, "skill.published", true);
        }

        // Lock the skill: publishers of one skill queue up, and each sees the versions before it.
        const [skill] = await tx
          .select()
          .from(skills)
          .where(eq(skills.name, parsed.name))
          .for("update");
        if (skill === undefined) {
          throw new Error("skill vanished while publishing");
        }
        if (skill.kind !== parsed.kind) {
          throw conflict(`The skill ${skill.name} is a ${skill.kind}, not a ${parsed.kind}.`, {
            reason: "kind_mismatch",
            kind: skill.kind,
          });
        }

        const [same] = await tx
          .select()
          .from(skillVersions)
          .where(and(eq(skillVersions.skillId, skill.id), eq(skillVersions.checksum, checksum)))
          .limit(1);
        if (same !== undefined) {
          if (same.id === skill.currentVersionId) {
            return {
              version: toSkillVersionSummary(skill, same),
              created: false,
              restored: false,
              syncJobId: null,
            };
          }
          // The files of an earlier version: make it current again.
          const [restored] = await tx
            .update(skills)
            .set({ currentVersionId: same.id })
            .where(eq(skills.id, skill.id))
            .returning();
          return finish(tx, restored ?? skill, same, "skill.restored", false);
        }

        const next = await nextSkillVersion(tx, skill.id);
        if (next === null) {
          throw new Error("skill vanished while publishing");
        }
        const [version] = await tx
          .insert(skillVersions)
          .values({
            skillId: skill.id,
            version: next,
            files: parsed.files,
            checksum,
            changelog: parsed.changelog ?? null,
            publishedByUser: actor.userId,
            publishedByToken: actor.kind === "token" ? actor.id : null,
          })
          .returning();
        if (version === undefined) {
          throw new Error("skill version was not inserted");
        }
        const [updated] = await tx
          .update(skills)
          .set({ currentVersionId: version.id })
          .where(eq(skills.id, skill.id))
          .returning();
        return finish(tx, updated ?? skill, version, "skill.published", true);
      });
    },

    async list() {
      const rows = await db
        .select({ skill: skills, current: skillVersions })
        .from(skills)
        .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
        .orderBy(asc(skills.name));
      return rows.map(({ skill, current }) => toSkillSummary(skill, current));
    },

    async get(name, version) {
      const skill = await skillByName(db, name);
      if (skill === null) {
        return null;
      }
      if (version === undefined) {
        return toSkillVersionDetail(skill, await versionById(db, skill.currentVersionId));
      }
      const [row] = await db
        .select()
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, skill.id), eq(skillVersions.version, version)))
        .limit(1);
      return row === undefined ? null : toSkillVersionDetail(skill, row);
    },

    async versions(name) {
      const skill = await skillByName(db, name);
      if (skill === null) {
        return null;
      }
      const rows = await db
        .select()
        .from(skillVersions)
        .where(eq(skillVersions.skillId, skill.id))
        .orderBy(desc(skillVersions.version));
      return rows.map((row) => toSkillVersionSummary(skill, row));
    },

    async pullAll() {
      const rows = await db
        .select({ skill: skills, current: skillVersions })
        .from(skills)
        .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
        .orderBy(asc(skills.name));
      return rows.map(({ skill, current }) => toSkillVersionDetail(skill, current));
    },
  };
}
