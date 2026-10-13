import { randomUUID } from "node:crypto";
import { type LiveEvent, ProjectSchema, SLUG_MAX_LENGTH } from "@loomcast/contracts";
import { auditLog, conversations } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  baseSlug,
  createProjectsService,
  FALLBACK_SLUG,
  slugWithSuffix,
} from "../src/modules/projects";
import { createTestApp, errorCode, insertUser, login, send, type TestApp } from "./support";

let testDb: TestDb;
let t: TestApp;
let cookie: string;
let userId: string;
let events: LiveEvent[];

beforeAll(async () => {
  testDb = await createTestDb();
  t = createTestApp(testDb.db);
  events = [];
  t.bus.subscribeLive((event) => {
    events.push(event);
  });
  const user = await insertUser(testDb.db);
  userId = user.id;
  ({ cookie } = await login(t.app, user.email));
});

afterAll(async () => {
  await testDb.drop();
});

/** A name no other test uses, so slugs never collide across tests. */
function uniqueName(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

async function create(body: Record<string, unknown>) {
  const response = await send(t.app, "POST", "/api/projects", { cookie, body });
  return { response, json: (await response.json()) as Record<string, unknown> };
}

async function createProject(name: string) {
  const { response, json } = await create({ name });
  expect(response.status).toBe(201);
  return ProjectSchema.parse(json);
}

async function auditRows(targetId: string) {
  return testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "project"), eq(auditLog.targetId, targetId)));
}

describe("slug helpers", () => {
  it("derives a slug from the name and falls back when nothing is left", () => {
    expect(baseSlug("Rust in 60 Seconds!")).toBe("rust-in-60-seconds");
    expect(baseSlug("Ünïcode Straße")).toBe("unicode-strasse");
    expect(baseSlug("日本語")).toBe(FALLBACK_SLUG);
    expect(baseSlug("123e4567-e89b-42d3-a456-426614174000")).toBe(FALLBACK_SLUG);
  });

  it("keeps suffixed slugs within the length limit", () => {
    const long = "a".repeat(SLUG_MAX_LENGTH);
    expect(slugWithSuffix(long, 2)).toHaveLength(SLUG_MAX_LENGTH);
    expect(slugWithSuffix(long, 2).endsWith("-2")).toBe(true);
    expect(slugWithSuffix(`${"a".repeat(61)}-bc`, 10)).toBe(`${"a".repeat(61)}-10`);
    expect(slugWithSuffix(`${"a".repeat(60)}-bcd`, 12)).toBe(`${"a".repeat(60)}-12`);
  });
});

describe("POST /api/projects", () => {
  it("creates a project, writes an audit row and publishes project.created", async () => {
    const name = uniqueName("Rust in 60 Seconds");
    const { response, json } = await create({ name, description: "Short Rust tips" });
    expect(response.status).toBe(201);
    const project = ProjectSchema.parse(json);
    expect(project).toMatchObject({
      name,
      slug: baseSlug(name),
      description: "Short Rust tips",
      status: "active",
      archivedAt: null,
    });
    expect(events).toContainEqual({ type: "project.created", payload: { project } });

    const rows = await auditRows(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: "user",
      actorId: userId,
      action: "project.created",
      data: { slug: project.slug, name },
    });
  });

  it("adds -2, -3 to derived slugs that collide", async () => {
    const name = uniqueName("Collide");
    const first = await createProject(name);
    const second = await createProject(name);
    const third = await createProject(`${name}!`);
    expect([first.slug, second.slug, third.slug]).toEqual([
      baseSlug(name),
      `${baseSlug(name)}-2`,
      `${baseSlug(name)}-3`,
    ]);
  });

  it("gives parallel creates of the same name distinct slugs", async () => {
    const name = uniqueName("Parallel");
    const created = await Promise.all(Array.from({ length: 6 }, () => createProject(name)));
    const slugs = created.map((project) => project.slug).sort();
    expect(new Set(slugs).size).toBe(6);
    expect(slugs).toContain(baseSlug(name));
  });

  it("suffixes long names without passing the slug limit", async () => {
    const name = `${"long ".repeat(20)}${randomUUID().slice(0, 8)}`;
    const first = await createProject(name);
    const second = await createProject(name);
    expect(first.slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(second.slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(second.slug).toBe(slugWithSuffix(first.slug, 2));
  });

  it("uses an explicit slug and rejects one that is taken", async () => {
    const slug = `explicit-${randomUUID().slice(0, 8)}`;
    const first = await create({ name: "Explicit", slug });
    expect(first.response.status).toBe(201);
    expect(first.json.slug).toBe(slug);

    const second = await create({ name: "Explicit again", slug });
    expect(second.response.status).toBe(409);
    expect(second.json).toMatchObject({ error: { code: "conflict" } });
  });

  it("stores an empty description as null", async () => {
    const { json } = await create({ name: uniqueName("Blank"), description: "   " });
    expect(json.description).toBeNull();
  });

  it("validates the body", async () => {
    const empty = await create({ name: "   " });
    expect(empty.response.status).toBe(400);
    expect(empty.json).toMatchObject({ error: { code: "validation_failed" } });
    const uuidSlug = await create({ name: "Bad", slug: randomUUID() });
    expect(uuidSlug.response.status).toBe(400);
  });
});

describe("GET /api/projects", () => {
  it("lists projects, most recently updated first, and filters by status", async () => {
    const older = await createProject(uniqueName("Older"));
    const newer = await createProject(uniqueName("Newer"));

    const response = await send(t.app, "GET", "/api/projects", { cookie });
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: unknown[] };
    const ids = items.map((item) => ProjectSchema.parse(item).id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));

    await send(t.app, "POST", `/api/projects/${older.id}/archive`, { cookie });
    const archived = await send(t.app, "GET", "/api/projects?status=archived", { cookie });
    const archivedIds = ((await archived.json()) as { items: { id: string }[] }).items.map(
      (item) => item.id,
    );
    expect(archivedIds).toContain(older.id);
    expect(archivedIds).not.toContain(newer.id);

    const invalid = await send(t.app, "GET", "/api/projects?status=deleted", { cookie });
    expect(invalid.status).toBe(400);
  });
});

describe("GET /api/projects/:idOrSlug", () => {
  it("finds a project by id or by slug", async () => {
    const project = await createProject(uniqueName("Lookup"));
    for (const key of [project.id, project.slug]) {
      const response = await send(t.app, "GET", `/api/projects/${key}`, { cookie });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(project);
    }
  });

  it("answers 404 for unknown ids, slugs and malformed keys", async () => {
    for (const key of [randomUUID(), "no-such-project", "Not A Slug", "x".repeat(65)]) {
      const response = await send(t.app, "GET", `/api/projects/${encodeURIComponent(key)}`, {
        cookie,
      });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("not_found");
    }
  });
});

describe("PATCH /api/projects/:idOrSlug", () => {
  it("updates name and description, keeps the slug and publishes project.updated", async () => {
    const project = await createProject(uniqueName("Patch"));
    const response = await send(t.app, "PATCH", `/api/projects/${project.slug}`, {
      cookie,
      body: { name: "Renamed", description: "Now described" },
    });
    expect(response.status).toBe(200);
    const updated = ProjectSchema.parse(await response.json());
    expect(updated).toMatchObject({
      id: project.id,
      slug: project.slug,
      name: "Renamed",
      description: "Now described",
    });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(project.updatedAt));
    expect(events).toContainEqual({ type: "project.updated", payload: { project: updated } });

    const cleared = await send(t.app, "PATCH", `/api/projects/${project.id}`, {
      cookie,
      body: { description: null },
    });
    expect(((await cleared.json()) as { description: unknown }).description).toBeNull();

    const actions = (await auditRows(project.id)).map((row) => row.action);
    expect(actions).toEqual(["project.created", "project.updated", "project.updated"]);
  });

  it("rejects an empty update and unknown projects", async () => {
    const project = await createProject(uniqueName("Empty patch"));
    const empty = await send(t.app, "PATCH", `/api/projects/${project.id}`, { cookie, body: {} });
    expect(empty.status).toBe(400);
    const missing = await send(t.app, "PATCH", `/api/projects/${randomUUID()}`, {
      cookie,
      body: { name: "Ghost" },
    });
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/projects/:id/archive", () => {
  it("archives once and leaves an archived project unchanged", async () => {
    const project = await createProject(uniqueName("Archive"));
    const before = events.length;
    const response = await send(t.app, "POST", `/api/projects/${project.id}/archive`, { cookie });
    expect(response.status).toBe(200);
    const archived = ProjectSchema.parse(await response.json());
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();
    expect(events.slice(before)).toEqual([
      { type: "project.updated", payload: { project: archived } },
    ]);

    const again = await send(t.app, "POST", `/api/projects/${project.id}/archive`, { cookie });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(archived);
    expect(events).toHaveLength(before + 1);

    const actions = (await auditRows(project.id)).map((row) => row.action);
    expect(actions).toEqual(["project.created", "project.archived"]);
  });

  it("answers 404 for a slug or an unknown id", async () => {
    const project = await createProject(uniqueName("Archive by slug"));
    const bySlug = await send(t.app, "POST", `/api/projects/${project.slug}/archive`, { cookie });
    expect(bySlug.status).toBe(404);
    const unknown = await send(t.app, "POST", `/api/projects/${randomUUID()}/archive`, { cookie });
    expect(unknown.status).toBe(404);
  });
});

describe("authentication", () => {
  it("requires a session on every project route", async () => {
    const id = randomUUID();
    const requests: [string, string, unknown?][] = [
      ["GET", "/api/projects"],
      ["POST", "/api/projects", { name: "Anonymous" }],
      ["GET", `/api/projects/${id}`],
      ["PATCH", `/api/projects/${id}`, { name: "Anonymous" }],
      ["POST", `/api/projects/${id}/archive`],
    ];
    for (const [method, path, body] of requests) {
      const response = await send(t.app, method, path, { body });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("applies the CSRF guard to writes", async () => {
    const crossSite = await send(t.app, "POST", "/api/projects", {
      cookie,
      body: { name: "Cross site" },
      origin: "https://evil.example.test",
    });
    expect(crossSite.status).toBe(403);
    const form = await send(t.app, "PATCH", `/api/projects/${randomUUID()}`, {
      cookie,
      body: "name=x",
      contentType: "application/x-www-form-urlencoded",
    });
    expect(form.status).toBe(403);
  });
});

describe("projectsService", () => {
  it("creates on behalf of a token, audited as the token", async () => {
    const service = createProjectsService(t.deps);
    const tokenId = randomUUID();
    const project = await service.create(
      { name: uniqueName("From a tool") },
      { kind: "token", id: tokenId, userId },
    );
    expect(await service.get(project.slug)).toEqual(project);
    expect((await service.list()).map((item) => item.id)).toContain(project.id);
    const [row] = await auditRows(project.id);
    expect(row).toMatchObject({ actorKind: "token", actorId: tokenId });
  });

  it("counts a project's conversations", async () => {
    const service = createProjectsService(t.deps);
    const project = await createProject(uniqueName("Stats"));
    await testDb.db.insert(conversations).values([
      { projectId: project.id, createdBy: userId },
      { projectId: project.id, createdBy: userId },
    ]);
    expect(await service.stats(project.id)).toEqual({ conversations: 2, kbEntries: 0, items: 0 });
  });
});
