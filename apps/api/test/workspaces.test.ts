import { randomUUID } from "node:crypto";
import { type LiveEvent, SLUG_MAX_LENGTH, WorkspaceSchema } from "@loomcast/contracts";
import { auditLog, conversations } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  baseSlug,
  createWorkspacesService,
  FALLBACK_SLUG,
  slugWithSuffix,
} from "../src/modules/workspaces";
import { insertChannel, testKeyring } from "./publisher-support";
import {
  createTestApp,
  errorCode,
  insertUser,
  insertWorkspace,
  login,
  send,
  type TestApp,
} from "./support";

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
  const response = await send(t.app, "POST", "/api/workspaces", { cookie, body });
  return { response, json: (await response.json()) as Record<string, unknown> };
}

async function createWorkspace(name: string) {
  const { response, json } = await create({ name });
  expect(response.status).toBe(201);
  return WorkspaceSchema.parse(json);
}

async function auditRows(targetId: string) {
  return testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "workspace"), eq(auditLog.targetId, targetId)));
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

describe("POST /api/workspaces", () => {
  it("creates a workspace, writes an audit row and publishes workspace.created", async () => {
    const name = uniqueName("Rust in 60 Seconds");
    const { response, json } = await create({ name, description: "Short Rust tips" });
    expect(response.status).toBe(201);
    const workspace = WorkspaceSchema.parse(json);
    expect(workspace).toMatchObject({
      name,
      slug: baseSlug(name),
      description: "Short Rust tips",
      status: "active",
      archivedAt: null,
    });
    expect(events).toContainEqual({ type: "workspace.created", payload: { workspace } });

    const rows = await auditRows(workspace.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: "user",
      actorId: userId,
      action: "workspace.created",
      data: { slug: workspace.slug, name },
    });
  });

  it("adds -2, -3 to derived slugs that collide", async () => {
    const name = uniqueName("Collide");
    const first = await createWorkspace(name);
    const second = await createWorkspace(name);
    const third = await createWorkspace(`${name}!`);
    expect([first.slug, second.slug, third.slug]).toEqual([
      baseSlug(name),
      `${baseSlug(name)}-2`,
      `${baseSlug(name)}-3`,
    ]);
  });

  it("gives parallel creates of the same name distinct slugs", async () => {
    const name = uniqueName("Parallel");
    const created = await Promise.all(Array.from({ length: 6 }, () => createWorkspace(name)));
    const slugs = created.map((workspace) => workspace.slug).sort();
    expect(new Set(slugs).size).toBe(6);
    expect(slugs).toContain(baseSlug(name));
  });

  it("suffixes long names without passing the slug limit", async () => {
    const name = `${"long ".repeat(20)}${randomUUID().slice(0, 8)}`;
    const first = await createWorkspace(name);
    const second = await createWorkspace(name);
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

describe("GET /api/workspaces", () => {
  it("lists workspaces, most recently updated first, and filters by status", async () => {
    const older = await createWorkspace(uniqueName("Older"));
    const newer = await createWorkspace(uniqueName("Newer"));

    const response = await send(t.app, "GET", "/api/workspaces", { cookie });
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: unknown[] };
    const ids = items.map((item) => WorkspaceSchema.parse(item).id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));

    await send(t.app, "POST", `/api/workspaces/${older.id}/archive`, { cookie });
    const archived = await send(t.app, "GET", "/api/workspaces?status=archived", { cookie });
    const archivedIds = ((await archived.json()) as { items: { id: string }[] }).items.map(
      (item) => item.id,
    );
    expect(archivedIds).toContain(older.id);
    expect(archivedIds).not.toContain(newer.id);

    const invalid = await send(t.app, "GET", "/api/workspaces?status=deleted", { cookie });
    expect(invalid.status).toBe(400);
  });
});

describe("GET /api/workspaces/:idOrSlug", () => {
  it("finds a workspace by id or by slug", async () => {
    const workspace = await createWorkspace(uniqueName("Lookup"));
    for (const key of [workspace.id, workspace.slug]) {
      const response = await send(t.app, "GET", `/api/workspaces/${key}`, { cookie });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(workspace);
    }
  });

  it("answers 404 for unknown ids, slugs and malformed keys", async () => {
    for (const key of [randomUUID(), "no-such-workspace", "Not A Slug", "x".repeat(65)]) {
      const response = await send(t.app, "GET", `/api/workspaces/${encodeURIComponent(key)}`, {
        cookie,
      });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("not_found");
    }
  });
});

describe("PATCH /api/workspaces/:idOrSlug", () => {
  it("updates name and description, keeps the slug and publishes workspace.updated", async () => {
    const workspace = await createWorkspace(uniqueName("Patch"));
    const response = await send(t.app, "PATCH", `/api/workspaces/${workspace.slug}`, {
      cookie,
      body: { name: "Renamed", description: "Now described" },
    });
    expect(response.status).toBe(200);
    const updated = WorkspaceSchema.parse(await response.json());
    expect(updated).toMatchObject({
      id: workspace.id,
      slug: workspace.slug,
      name: "Renamed",
      description: "Now described",
    });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(workspace.updatedAt));
    expect(events).toContainEqual({ type: "workspace.updated", payload: { workspace: updated } });

    const cleared = await send(t.app, "PATCH", `/api/workspaces/${workspace.id}`, {
      cookie,
      body: { description: null },
    });
    expect(((await cleared.json()) as { description: unknown }).description).toBeNull();

    const actions = (await auditRows(workspace.id)).map((row) => row.action);
    expect(actions).toEqual(["workspace.created", "workspace.updated", "workspace.updated"]);
  });

  it("rejects an empty update and unknown workspaces", async () => {
    const workspace = await createWorkspace(uniqueName("Empty patch"));
    const empty = await send(t.app, "PATCH", `/api/workspaces/${workspace.id}`, {
      cookie,
      body: {},
    });
    expect(empty.status).toBe(400);
    const missing = await send(t.app, "PATCH", `/api/workspaces/${randomUUID()}`, {
      cookie,
      body: { name: "Ghost" },
    });
    expect(missing.status).toBe(404);
  });
});

describe("workspace appearance", () => {
  const ICON_URL_RE = /^\/api\/workspaces\/[0-9a-f-]{36}\/icon\?v=\d+$/;
  /** A 1x1 transparent PNG. */
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  function patch(idOrSlug: string, body: unknown) {
    return send(t.app, "PATCH", `/api/workspaces/${idOrSlug}`, { cookie, body });
  }

  function putIcon(id: string, body: unknown) {
    return send(t.app, "PUT", `/api/workspaces/${id}/icon`, { cookie, body });
  }

  it("starts in Thread, UTC and without an icon", async () => {
    const workspace = await createWorkspace(uniqueName("Defaults"));
    expect(workspace).toMatchObject({ color: "thread", timeZone: "UTC", iconUrl: null });
  });

  it("changes the color and the time zone, and refuses unknown ones", async () => {
    const workspace = await createWorkspace(uniqueName("Colors"));
    const response = await patch(workspace.slug, { color: "ember", timeZone: "Asia/Colombo" });
    expect(response.status).toBe(200);
    const updated = WorkspaceSchema.parse(await response.json());
    expect(updated).toMatchObject({ id: workspace.id, color: "ember", timeZone: "Asia/Colombo" });
    expect(events).toContainEqual({ type: "workspace.updated", payload: { workspace: updated } });

    const badZone = await patch(workspace.id, { timeZone: "Mars/Olympus_Mons" });
    expect(badZone.status).toBe(400);
    expect(await errorCode(badZone)).toBe("validation_failed");
    const badColor = await patch(workspace.id, { color: "chartreuse" });
    expect(badColor.status).toBe(400);
    expect(await errorCode(badColor)).toBe("validation_failed");

    const fetched = await send(t.app, "GET", `/api/workspaces/${workspace.id}`, { cookie });
    expect(WorkspaceSchema.parse(await fetched.json())).toMatchObject({
      color: "ember",
      timeZone: "Asia/Colombo",
    });
  });

  it("stores an uploaded icon, serves it and clears it", async () => {
    const workspace = await createWorkspace(uniqueName("Icon"));
    expect(
      (await send(t.app, "GET", `/api/workspaces/${workspace.id}/icon`, { cookie })).status,
    ).toBe(404);

    const response = await putIcon(workspace.id, { mime: "image/png", data: PNG_BASE64 });
    expect(response.status).toBe(200);
    const withIcon = WorkspaceSchema.parse(await response.json());
    expect(withIcon.iconUrl).toMatch(ICON_URL_RE);
    expect(withIcon.iconUrl?.startsWith(`/api/workspaces/${workspace.id}/icon?v=`)).toBe(true);

    const icon = await send(t.app, "GET", withIcon.iconUrl ?? "", { cookie });
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(Buffer.from(PNG_BASE64, "base64"));
    expect((await t.app.request(withIcon.iconUrl ?? "")).status).toBe(401);

    // A new upload gets a new URL, so browsers drop the cached one.
    t.clock.advance(1_000);
    const again = WorkspaceSchema.parse(
      await (await putIcon(workspace.id, { mime: "image/png", data: PNG_BASE64 })).json(),
    );
    expect(again.iconUrl).toMatch(ICON_URL_RE);
    expect(again.iconUrl).not.toBe(withIcon.iconUrl);

    const cleared = await send(t.app, "DELETE", `/api/workspaces/${workspace.id}/icon`, { cookie });
    expect(cleared.status).toBe(200);
    expect(WorkspaceSchema.parse(await cleared.json()).iconUrl).toBeNull();
    expect(
      (await send(t.app, "GET", `/api/workspaces/${workspace.id}/icon`, { cookie })).status,
    ).toBe(404);
  });

  it("refuses icons that are not PNG, JPEG or WebP bytes, whatever the declared type", async () => {
    const workspace = await createWorkspace(uniqueName("Bad icon"));
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>',
    ).toString("base64");
    for (const body of [
      { mime: "image/png", data: svg },
      { mime: "image/svg+xml", data: svg },
      { mime: "image/jpeg", data: Buffer.from("not an image at all").toString("base64") },
      { mime: "image/webp", data: "" },
    ]) {
      const response = await putIcon(workspace.id, body);
      expect(response.status, body.mime).toBe(400);
      expect(await errorCode(response)).toBe("validation_failed");
    }
    const unknown = await putIcon(randomUUID(), { mime: "image/png", data: PNG_BASE64 });
    expect(unknown.status).toBe(404);
    const fetched = await send(t.app, "GET", `/api/workspaces/${workspace.id}`, { cookie });
    expect(WorkspaceSchema.parse(await fetched.json()).iconUrl).toBeNull();
  });

  it("takes a picture only from a channel of the same workspace", async () => {
    const workspace = await createWorkspace(uniqueName("Borrowed icon"));
    const other = await insertWorkspace(testDb.db, { createdBy: userId });
    const foreign = await insertChannel(testDb.db, testKeyring(), { workspaceId: other });
    const response = await putIcon(workspace.id, { fromChannelId: foreign.id });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_failed",
        details: [{ path: "fromChannelId", message: "No channel of this workspace has that id" }],
      },
    });
  });
});

describe("POST /api/workspaces/:id/archive", () => {
  it("archives once and leaves an archived workspace unchanged", async () => {
    const workspace = await createWorkspace(uniqueName("Archive"));
    const before = events.length;
    const response = await send(t.app, "POST", `/api/workspaces/${workspace.id}/archive`, {
      cookie,
    });
    expect(response.status).toBe(200);
    const archived = WorkspaceSchema.parse(await response.json());
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();
    expect(events.slice(before)).toEqual([
      { type: "workspace.updated", payload: { workspace: archived } },
    ]);

    const again = await send(t.app, "POST", `/api/workspaces/${workspace.id}/archive`, { cookie });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(archived);
    expect(events).toHaveLength(before + 1);

    const actions = (await auditRows(workspace.id)).map((row) => row.action);
    expect(actions).toEqual(["workspace.created", "workspace.archived"]);
  });

  it("answers 404 for a slug or an unknown id", async () => {
    const workspace = await createWorkspace(uniqueName("Archive by slug"));
    const bySlug = await send(t.app, "POST", `/api/workspaces/${workspace.slug}/archive`, {
      cookie,
    });
    expect(bySlug.status).toBe(404);
    const unknown = await send(t.app, "POST", `/api/workspaces/${randomUUID()}/archive`, {
      cookie,
    });
    expect(unknown.status).toBe(404);
  });
});

describe("authentication", () => {
  it("requires a session on every workspace route", async () => {
    const id = randomUUID();
    const requests: [string, string, unknown?][] = [
      ["GET", "/api/workspaces"],
      ["POST", "/api/workspaces", { name: "Anonymous" }],
      ["GET", `/api/workspaces/${id}`],
      ["PATCH", `/api/workspaces/${id}`, { name: "Anonymous" }],
      ["POST", `/api/workspaces/${id}/archive`],
    ];
    for (const [method, path, body] of requests) {
      const response = await send(t.app, method, path, { body });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("applies the CSRF guard to writes", async () => {
    const crossSite = await send(t.app, "POST", "/api/workspaces", {
      cookie,
      body: { name: "Cross site" },
      origin: "https://evil.example.test",
    });
    expect(crossSite.status).toBe(403);
    const form = await send(t.app, "PATCH", `/api/workspaces/${randomUUID()}`, {
      cookie,
      body: "name=x",
      contentType: "application/x-www-form-urlencoded",
    });
    expect(form.status).toBe(403);
  });
});

describe("workspacesService", () => {
  it("creates on behalf of a token, audited as the token", async () => {
    const service = createWorkspacesService(t.deps);
    const tokenId = randomUUID();
    const workspace = await service.create(
      { name: uniqueName("From a tool") },
      { kind: "token", id: tokenId, userId },
    );
    expect(await service.get(workspace.slug)).toEqual(workspace);
    expect((await service.list()).map((item) => item.id)).toContain(workspace.id);
    const [row] = await auditRows(workspace.id);
    expect(row).toMatchObject({ actorKind: "token", actorId: tokenId });
  });

  it("counts a workspace's conversations", async () => {
    const service = createWorkspacesService(t.deps);
    const workspace = await createWorkspace(uniqueName("Stats"));
    await testDb.db.insert(conversations).values([
      { workspaceId: workspace.id, createdBy: userId },
      { workspaceId: workspace.id, createdBy: userId },
    ]);
    expect(await service.stats(workspace.id)).toEqual({ conversations: 2, kbEntries: 0, items: 0 });
  });
});
