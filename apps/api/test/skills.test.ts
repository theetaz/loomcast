import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  listSchema,
  type SkillFile,
  SkillSummarySchema,
  SkillVersionDetailSchema,
  SkillVersionSummarySchema,
  skillChecksumInput,
} from "@loomcast/contracts";
import { auditLog, jobs, skills, skillVersions } from "@loomcast/db";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSkillSources, runSkills } from "../src/cli/skills";
import { HttpError } from "../src/lib/errors";
import {
  type SkillActor,
  type SkillsService,
  skillChecksum,
  skillsServiceFor,
} from "../src/modules/skills";
import {
  call,
  createPipelineHarness,
  eventsOf,
  insertProject,
  type PipelineHarness,
} from "./pipeline-support";
import { errorCode, insertUser } from "./support";

const STUDIO_SKILLS = fileURLToPath(new URL("../../../studio/skills", import.meta.url));

let h: PipelineHarness;
let service: SkillsService;
let actor: SkillActor;
let tmp: string;

beforeAll(async () => {
  h = await createPipelineHarness();
  service = skillsServiceFor(h.deps);
  actor = { kind: "user", id: h.userId, userId: h.userId };
  await insertProject(h);
  tmp = await mkdtemp(join(tmpdir(), "loomcast-skills-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  await h?.close();
});

let counter = 0;
/** A skill name no other test uses. */
function uniqueName(label: string): string {
  counter += 1;
  return `${label}-${counter}`;
}

function filesOf(name: string, body: string, kind: "skill" | "recipe" = "skill"): SkillFile[] {
  return [
    { path: "SKILL.md", content: body },
    {
      path: "skill.json",
      content: JSON.stringify({ name, kind, description: `About ${name}.` }),
    },
    { path: "templates/hook.md", content: "Open on the result." },
  ];
}

async function syncJobs(name: string) {
  return h.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "skills.sync"), like(jobs.idempotencyKey, "skills:%")))
    .then((rows) =>
      rows.filter((row) => (row.payload.names as string[] | undefined)?.[0] === name),
    );
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

class Sink extends Writable {
  text = "";
  override _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.text += chunk.toString("utf8");
    done();
  }
}

describe("skills service", () => {
  it("checksums the sorted path and content pairs", () => {
    const files = filesOf("checksum", "Body");
    const expected = createHash("sha256")
      .update(Buffer.from(skillChecksumInput(files), "utf8"))
      .digest("hex");
    expect(skillChecksum(files)).toBe(expected);
    expect(skillChecksum([...files].reverse())).toBe(expected);
    expect(skillChecksum(filesOf("checksum", "Other body"))).not.toBe(expected);
  });

  it("publishes version 1, then returns it for identical files", async () => {
    const name = uniqueName("scripting");
    const files = filesOf(name, "Write a hook first.");
    const first = await service.publish({ name, kind: "skill", files, changelog: "First" }, actor);
    expect(first.created).toBe(true);
    expect(first.restored).toBe(false);
    expect(first.version).toMatchObject({
      name,
      kind: "skill",
      version: 1,
      checksum: skillChecksum(files),
      changelog: "First",
      fileCount: 3,
      publishedByUser: h.userId,
    });
    expect(first.syncJobId).not.toBeNull();

    // Same files in another order: no new version, no new sync job, no event.
    const events = eventsOf(h.live, "skill.published").length;
    const again = await service.publish(
      { name, kind: "skill", files: [...files].reverse() },
      actor,
    );
    expect(again).toMatchObject({ created: false, restored: false, syncJobId: null });
    expect(again.version.version).toBe(1);
    expect(eventsOf(h.live, "skill.published")).toHaveLength(events);

    const rows = await h.db
      .select()
      .from(skillVersions)
      .innerJoin(skills, eq(skills.id, skillVersions.skillId))
      .where(eq(skills.name, name));
    expect(rows).toHaveLength(1);
    const sync = await syncJobs(name);
    expect(sync).toHaveLength(1);
    expect(sync[0]).toMatchObject({
      id: first.syncJobId,
      idempotencyKey: `skills:${first.version.checksum}`,
      status: "queued",
      createdBy: h.userId,
      payload: { names: [name] },
    });
  });

  it("creates the next version for changed files and announces it", async () => {
    const name = uniqueName("storyboarding");
    await service.publish({ name, kind: "skill", files: filesOf(name, "v1") }, actor);
    const second = await service.publish(
      { name, kind: "skill", files: filesOf(name, "v2"), changelog: "Tighter" },
      actor,
    );
    expect(second.created).toBe(true);
    expect(second.version.version).toBe(2);
    const announced = eventsOf(h.live, "skill.published").filter(
      (event) => event.payload.skill.name === name,
    );
    expect(announced.map((event) => event.payload.skill.version)).toEqual([1, 2]);
    const audits = await h.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "skill.published"), eq(auditLog.targetId, second.version.skillId)),
      );
    expect(audits).toHaveLength(2);
    expect(await syncJobs(name)).toHaveLength(2);
  });

  it("makes an earlier version current again when its files are published", async () => {
    const name = uniqueName("revision");
    const v1 = await service.publish({ name, kind: "skill", files: filesOf(name, "one") }, actor);
    await service.publish({ name, kind: "skill", files: filesOf(name, "two") }, actor);
    const back = await service.publish({ name, kind: "skill", files: filesOf(name, "one") }, actor);
    expect(back).toMatchObject({ created: false, restored: true });
    expect(back.version.version).toBe(1);
    expect(back.syncJobId).not.toBeNull();
    expect((await service.get(name))?.checksum).toBe(v1.version.checksum);
    expect(await service.versions(name)).toHaveLength(2);
    // Publishing the current files again is a no-op.
    const same = await service.publish({ name, kind: "skill", files: filesOf(name, "one") }, actor);
    expect(same).toMatchObject({ created: false, restored: false, syncJobId: null });
  });

  it("serialises concurrent publishes of the same skill", async () => {
    const name = uniqueName("parallel");
    const files = filesOf(name, "Same files from two clients.");
    const results = await Promise.all([
      service.publish({ name, kind: "skill", files }, actor),
      service.publish({ name, kind: "skill", files }, actor),
      service.publish({ name, kind: "skill", files }, actor),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.version.version))).toEqual(new Set([1]));
  });

  it("rejects paths that leave the skill directory", async () => {
    for (const path of [
      "../escape.md",
      "a/../../b.md",
      "/abs.md",
      "a//b.md",
      "./x.md",
      "a\\b.md",
    ]) {
      const error = await rejection(
        service.publish(
          { name: uniqueName("traversal"), kind: "skill", files: [{ path, content: "x" }] },
          actor,
        ),
      );
      expect(error.code, path).toBe("validation_failed");
    }
    const [row] = await h.db.select().from(skills).where(like(skills.name, "traversal-%"));
    expect(row).toBeUndefined();
  });

  it("checks skill.json against the published name and kind", async () => {
    const name = uniqueName("manifest");
    const wrongName = await rejection(
      service.publish({ name, kind: "skill", files: filesOf("someone-else", "x") }, actor),
    );
    expect(wrongName.code).toBe("validation_failed");
    const wrongKind = await rejection(
      service.publish({ name, kind: "skill", files: filesOf(name, "x", "recipe") }, actor),
    );
    expect(wrongKind.code).toBe("validation_failed");
    const broken = await rejection(
      service.publish(
        { name, kind: "skill", files: [{ path: "skill.json", content: "{not json" }] },
        actor,
      ),
    );
    expect(broken.code).toBe("validation_failed");

    // Without a manifest the skill is published without a description.
    const bare = await service.publish(
      { name, kind: "skill", files: [{ path: "SKILL.md", content: "Plain." }] },
      actor,
    );
    expect(bare.created).toBe(true);
    const listed = (await service.list()).find((skill) => skill.name === name);
    expect(listed?.description).toBeNull();
  });

  it("refuses to change a skill's kind", async () => {
    const name = uniqueName("kind");
    await service.publish({ name, kind: "skill", files: filesOf(name, "x") }, actor);
    const error = await rejection(
      service.publish({ name, kind: "recipe", files: filesOf(name, "y", "recipe") }, actor),
    );
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ reason: "kind_mismatch", kind: "skill" });
  });

  it("queues no sync job without a user to own it", async () => {
    const name = uniqueName("system");
    const result = await service.publish(
      { name, kind: "skill", files: filesOf(name, "x") },
      { kind: "system", id: null, userId: null },
    );
    expect(result.created).toBe(true);
    expect(result.syncJobId).toBeNull();
    expect(result.version.publishedByUser).toBeNull();
  });
});

describe("skills routes", () => {
  it("lists skills and reads versions", async () => {
    const name = uniqueName("routes");
    await service.publish({ name, kind: "recipe", files: filesOf(name, "a", "recipe") }, actor);
    await service.publish({ name, kind: "recipe", files: filesOf(name, "b", "recipe") }, actor);

    const list = await call(h, "GET", "/api/skills");
    expect(list.status).toBe(200);
    const listed = listSchema(SkillSummarySchema).parse(await list.json());
    const summary = listed.items.find((skill) => skill.name === name);
    expect(summary).toMatchObject({
      kind: "recipe",
      latestVersion: 2,
      description: `About ${name}.`,
    });
    const names = listed.items.map((skill) => skill.name);
    expect(names).toEqual([...names].sort());

    const latest = await call(h, "GET", `/api/skills/${name}`);
    expect(latest.status).toBe(200);
    const detail = SkillVersionDetailSchema.parse(await latest.json());
    expect(detail.version).toBe(2);
    expect(detail.files.find((file) => file.path === "SKILL.md")?.content).toBe("b");

    const first = await call(h, "GET", `/api/skills/${name}?version=1`);
    expect(SkillVersionDetailSchema.parse(await first.json()).version).toBe(1);

    const versions = await call(h, "GET", `/api/skills/${name}/versions`);
    expect(versions.status).toBe(200);
    const items = listSchema(SkillVersionSummarySchema).parse(await versions.json()).items;
    expect(items.map((item) => item.version)).toEqual([2, 1]);
    expect(items[0]?.bytes).toBeGreaterThan(0);
  });

  it("answers 404 for unknown skills and versions, and 401 without a session", async () => {
    expect((await call(h, "GET", "/api/skills/no-such-skill")).status).toBe(404);
    expect((await call(h, "GET", "/api/skills/NOT_A_NAME")).status).toBe(404);
    expect((await call(h, "GET", "/api/skills/no-such-skill/versions")).status).toBe(404);
    const name = uniqueName("missing-version");
    await service.publish({ name, kind: "skill", files: filesOf(name, "x") }, actor);
    expect((await call(h, "GET", `/api/skills/${name}?version=9`)).status).toBe(404);
    const invalid = await call(h, "GET", `/api/skills/${name}?version=0`);
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe("validation_failed");
    const anonymous = await h.t.app.request("/api/skills");
    expect(anonymous.status).toBe(401);
  });
});

describe("skills seed command", () => {
  async function writeSkill(root: string, dir: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, dir, path);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
  }

  function run(argv: string[]) {
    const stdout = new Sink();
    const stderr = new Sink();
    const database = { db: h.db, close: async () => {} };
    const env = { DATABASE_URL: "postgres://seed@127.0.0.1:1/unused" };
    return runSkills(argv, { stdout, stderr }, env, () => database).then((code) => ({
      code,
      stdout: stdout.text,
      stderr: stderr.text,
    }));
  }

  it("reads the bundled studio skills, recipes included", async () => {
    const sources = await readSkillSources(STUDIO_SKILLS);
    const names = sources.map((source) => source.name);
    expect(names).toContain("scriptwriting");
    expect(sources.find((source) => source.kind === "recipe")).toBeDefined();
    for (const source of sources) {
      expect(source.files.map((file) => file.path)).toContain("skill.json");
    }
  });

  it("publishes every skill directory once and is idempotent", async () => {
    const owner = await insertUser(h.db, { role: "owner" });
    const root = join(tmp, "seed");
    const alpha = uniqueName("seed-alpha");
    const beta = uniqueName("seed-beta");
    await writeSkill(root, alpha, {
      "skill.json": JSON.stringify({ name: alpha, kind: "skill", description: "Alpha." }),
      "SKILL.md": "Alpha body.",
      "notes/extra.md": "More.",
      ".DS_Store": "ignored",
    });
    await writeSkill(root, `recipes/${beta}`, {
      "skill.json": JSON.stringify({ name: beta, kind: "recipe", description: "Beta." }),
      "SKILL.md": "Beta body.",
    });

    const first = await run(["--", "seed", root]);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`${alpha}: published version 1`);
    expect(first.stdout).toContain(`${beta}: published version 1`);
    const alphaDetail = await service.get(alpha);
    expect(alphaDetail?.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "notes/extra.md",
      "skill.json",
    ]);
    expect(alphaDetail?.publishedByUser).toBe(owner.id);
    expect((await service.get(beta))?.kind).toBe("recipe");

    const second = await run(["seed", root]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`${alpha}: unchanged at version 1`);
    expect(second.stdout).toContain(`${beta}: unchanged at version 1`);
  });

  it("reports invalid skills and usage errors", async () => {
    const root = join(tmp, "broken");
    const name = uniqueName("seed-broken");
    await writeSkill(root, name, {
      "skill.json": JSON.stringify({ name, kind: "skill", description: "Broken." }),
      "bad name!.md": "Spaces and bangs are not allowed.",
    });
    const result = await run(["seed", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(name);
    expect(await service.get(name)).toBeNull();

    expect((await run([])).code).toBe(0);
    expect((await run(["publish", root])).code).toBe(2);
    expect((await run(["seed"])).code).toBe(2);
    expect((await run(["seed", join(tmp, "empty-dir-that-is-missing")])).code).toBe(1);
  });
});
