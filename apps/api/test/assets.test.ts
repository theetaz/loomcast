import { randomUUID } from "node:crypto";
import {
  AssetDetailSchema,
  AssetSchema,
  AssetUrlSchema,
  CreateUploadResponseSchema,
  type LiveEvent,
  listSchema,
} from "@loomcast/contracts";
import { assets, auditLog, contentItems, contentVersions, projects } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleDeps } from "../src/deps";
import { assetStorageKey, sha256HexToBase64 } from "../src/lib/storage";
import { PENDING_UPLOAD_TTL_MS } from "../src/modules/assets";
import {
  fakeStorageTarget,
  plantObject,
  putUpload,
  randomFile,
  removeObjects,
  resolveStorageTarget,
  type StorageTarget,
} from "./storage-support";
import { createTestApp, errorCode, insertUser, login, send, type TestApp } from "./support";

const target = await resolveStorageTarget();
const AssetListSchema = listSchema(AssetSchema);

let testDb: TestDb;
let t: TestApp;
let moduleDeps: ModuleDeps;
let cookie: string;
let userId: string;
let live: LiveEvent[];
const createdKeys: string[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  t = createTestApp(testDb.db, {
    config: { storage: target.config },
    modules: [
      (app, deps) => {
        moduleDeps = deps;
        return app;
      },
    ],
  });
  live = [];
  t.bus.subscribeLive((event) => {
    live.push(event);
  });
  const user = await insertUser(testDb.db);
  userId = user.id;
  ({ cookie } = await login(t.app, user.email));
});

afterAll(async () => {
  await removeObjects(target, target.config.bucket, createdKeys);
  await t.deps.lifecycle.close();
  await target.close();
  await testDb.drop();
});

async function newProject(status: "active" | "archived" = "active") {
  const [project] = await testDb.db
    .insert(projects)
    .values({
      slug: `assets-${randomUUID().slice(0, 8)}`,
      name: "Assets",
      status,
      archivedAt: status === "archived" ? new Date() : null,
      createdBy: userId,
    })
    .returning();
  if (project === undefined) {
    throw new Error("project was not inserted");
  }
  return project;
}

async function newItem(projectId: string) {
  const itemId = randomUUID();
  const versionId = randomUUID();
  await testDb.db.transaction(async (tx) => {
    await tx.insert(contentItems).values({
      id: itemId,
      projectId,
      title: "Item",
      createdVia: "ui",
      currentVersionId: versionId,
    });
    await tx
      .insert(contentVersions)
      .values({ id: versionId, itemId, versionNo: 1, stage: "idea", createdVia: "system" });
  });
  return itemId;
}

interface UploadRequest {
  projectId: string;
  itemId?: string;
  kind?: string;
  filename?: string;
  mime?: string;
  bytes?: number;
  sha256?: string;
}

/** Session cookies per app, as the fallback suite signs in to an app of its own. */
const cookies = new Map<TestApp, string>();

function cookieFor(app: TestApp): string {
  return cookies.get(app) ?? cookie;
}

function requestUpload(app: TestApp, body: UploadRequest) {
  return send(app.app, "POST", "/api/assets/uploads", {
    cookie: cookieFor(app),
    body: { kind: "render", filename: "final.mp4", mime: "video/mp4", ...body },
  });
}

/** Asks for an upload of `file` and returns the parsed response. */
async function startUpload(
  file: { bytes: Buffer; sha256: string },
  body: UploadRequest,
  app: TestApp = t,
) {
  const response = await requestUpload(app, {
    bytes: file.bytes.length,
    sha256: file.sha256,
    ...body,
  });
  expect(response.status).toBe(201);
  const parsed = CreateUploadResponseSchema.parse(await response.json());
  createdKeys.push(
    assetStorageKey(body.projectId, parsed.asset.kind, file.sha256, parsed.asset.mime),
  );
  return parsed;
}

function finalize(id: string, body?: unknown, app: TestApp = t) {
  return send(app.app, "POST", `/api/assets/${id}/finalize`, { cookie: cookieFor(app), body });
}

async function storedRow(id: string) {
  const [row] = await testDb.db.select().from(assets).where(eq(assets.id, id));
  return row;
}

describe("POST /api/assets/uploads", () => {
  it("needs a session", async () => {
    const response = await send(t.app, "POST", "/api/assets/uploads", { body: {} });
    expect(response.status).toBe(401);
  });

  it("checks the MIME type and size against the kind", async () => {
    const project = await newProject();
    const file = randomFile(16);
    const wrongType = await requestUpload(t, {
      projectId: project.id,
      kind: "voice",
      mime: "video/mp4",
      bytes: 16,
      sha256: file.sha256,
    });
    expect(wrongType.status).toBe(400);
    expect(await errorCode(wrongType)).toBe("validation_failed");

    const tooLarge = await requestUpload(t, {
      projectId: project.id,
      kind: "poster",
      mime: "image/png",
      bytes: 20 * 1024 * 1024 + 1,
      sha256: file.sha256,
    });
    expect(tooLarge.status).toBe(400);

    const badSha = await requestUpload(t, { projectId: project.id, bytes: 16, sha256: "abc" });
    expect(badSha.status).toBe(400);
  });

  it("refuses unknown and archived projects and items of other projects", async () => {
    const file = randomFile(16);
    const unknown = await requestUpload(t, {
      projectId: randomUUID(),
      bytes: 16,
      sha256: file.sha256,
    });
    expect(unknown.status).toBe(404);

    const archived = await newProject("archived");
    const response = await requestUpload(t, {
      projectId: archived.id,
      bytes: 16,
      sha256: file.sha256,
    });
    expect(response.status).toBe(409);

    const project = await newProject();
    const other = await newProject();
    const foreignItem = await newItem(other.id);
    const foreign = await requestUpload(t, {
      projectId: project.id,
      itemId: foreignItem,
      bytes: 16,
      sha256: file.sha256,
    });
    expect(foreign.status).toBe(400);
    expect(await errorCode(foreign)).toBe("validation_failed");
  });
});

describe(`upload and finalize against ${target.kind === "s3" ? "the S3 endpoint" : "the in-process fake"}`, () => {
  it("uploads straight to storage, verifies it and serves a download URL", async () => {
    const project = await newProject();
    const itemId = await newItem(project.id);
    const file = randomFile(48 * 1024);
    live.length = 0;

    const { asset, upload } = await startUpload(file, {
      projectId: project.id,
      itemId,
      filename: "Final cut.mp4",
    });
    expect(asset).toMatchObject({
      projectId: project.id,
      itemId,
      kind: "render",
      status: "pending",
      filename: "Final cut.mp4",
      mime: "video/mp4",
      bytes: file.bytes.length,
      sha256: file.sha256,
      finalizedAt: null,
    });
    expect(upload).not.toBeNull();
    expect(upload?.method).toBe("PUT");
    expect(upload?.headers).toEqual({
      "Content-Type": "video/mp4",
      "Content-Length": String(file.bytes.length),
      "x-amz-checksum-sha256": sha256HexToBase64(file.sha256),
    });
    expect(new URL(upload?.url ?? "").origin).toBe(new URL(target.config.endpoint).origin);

    const row = await storedRow(asset.id);
    expect(row?.storageKey).toBe(`projects/${project.id}/render/${file.sha256}.mp4`);
    expect(row?.bucket).toBe(target.config.bucket);
    expect(row?.createdByUser).toBe(userId);

    // A URL for a pending asset is refused.
    const early = await send(t.app, "GET", `/api/assets/${asset.id}/url`, { cookie });
    expect(early.status).toBe(409);

    if (upload === null) {
      throw new Error("expected an upload");
    }
    expect((await putUpload(upload, file.bytes)).status).toBe(200);

    const probe = { durationMs: 31_500, width: 1080, height: 1920, fps: 30, videoCodec: "h264" };
    const finalized = await finalize(asset.id, { probe });
    expect(finalized.status).toBe(200);
    const ready = AssetSchema.parse(await finalized.json());
    expect(ready).toMatchObject({
      id: asset.id,
      status: "ready",
      width: 1080,
      height: 1920,
      durationMs: 31_500,
      probe,
    });
    expect(ready.finalizedAt).not.toBeNull();

    // Finalizing again is a no-op.
    const again = await finalize(asset.id, {});
    expect(again.status).toBe(200);
    expect(AssetSchema.parse(await again.json()).finalizedAt).toBe(ready.finalizedAt);

    const detail = await send(t.app, "GET", `/api/assets/${asset.id}`, { cookie });
    expect(detail.status).toBe(200);
    expect(AssetDetailSchema.parse(await detail.json())).toMatchObject({
      id: asset.id,
      status: "ready",
      alignment: null,
    });

    const urlResponse = await send(
      t.app,
      "GET",
      `/api/assets/${asset.id}/url?disposition=attachment`,
      {
        cookie,
      },
    );
    expect(urlResponse.status).toBe(200);
    expect(urlResponse.headers.get("cache-control")).toBe("no-store");
    const { url } = AssetUrlSchema.parse(await urlResponse.json());
    const download = await fetch(url);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(
      'attachment; filename="Final cut.mp4"',
    );
    expect(Buffer.from(await download.arrayBuffer()).equals(file.bytes)).toBe(true);

    const statuses = live
      .filter((event) => event.type === "asset.updated" && event.payload.asset.id === asset.id)
      .map((event) => (event.type === "asset.updated" ? event.payload.asset.status : null));
    expect(statuses).toEqual(["pending", "ready"]);

    const audits = await testDb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, asset.id));
    expect(audits.map((entry) => entry.action).sort()).toEqual([
      "asset.finalized",
      "asset.upload_requested",
    ]);
  });

  it("keeps the asset pending when finalize comes before the upload", async () => {
    const project = await newProject();
    const file = randomFile(1024);
    const { asset } = await startUpload(file, { projectId: project.id });
    const response = await finalize(asset.id);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("upload_missing");
    expect((await storedRow(asset.id))?.status).toBe("pending");
  });

  it("fails and deletes an upload whose stored checksum does not match", async () => {
    const project = await newProject();
    const file = randomFile(2048);
    const { asset } = await startUpload(file, { projectId: project.id });
    const key = assetStorageKey(project.id, "render", file.sha256, "video/mp4");
    const other = randomFile(2048);
    await plantObject(target, key, other.bytes, "video/mp4");

    const response = await finalize(asset.id, { probe: { durationMs: 1 } });
    expect(response.status).toBe(200);
    const failed = AssetSchema.parse(await response.json());
    expect(failed.status).toBe("failed");
    expect(failed.probe).toBeNull();
    expect(await moduleDeps.storage.head(key)).toBeNull();

    const [entry] = await testDb.db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(
        and(eq(auditLog.targetId, asset.id), eq(auditLog.action, "asset.verification_failed")),
      );
    expect(entry?.data).toEqual({ reason: "checksum_mismatch" });

    const retry = await finalize(asset.id);
    expect(retry.status).toBe(409);
    expect(await errorCode(retry)).toBe("conflict");
  });

  it("fails an upload of the wrong size, then lets the same file start over", async () => {
    const project = await newProject();
    const file = randomFile(4096);
    const { asset } = await startUpload(file, { projectId: project.id });
    const key = assetStorageKey(project.id, "render", file.sha256, "video/mp4");
    await plantObject(target, key, file.bytes.subarray(0, 4000), "video/mp4");

    const response = await finalize(asset.id);
    const failed = AssetSchema.parse(await response.json());
    expect(failed.status).toBe("failed");
    expect(await moduleDeps.storage.head(key)).toBeNull();
    const [entry] = await testDb.db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(
        and(eq(auditLog.targetId, asset.id), eq(auditLog.action, "asset.verification_failed")),
      );
    expect(entry?.data).toEqual({ reason: "size_mismatch" });

    // Asking again for the same file reuses the failed row as a fresh pending upload.
    const again = await startUpload(file, { projectId: project.id, filename: "retry.mp4" });
    expect(again.asset.id).toBe(asset.id);
    expect(again.asset.status).toBe("pending");
    expect(again.asset.filename).toBe("retry.mp4");
    expect(again.upload).not.toBeNull();
    if (again.upload === null) {
      throw new Error("expected an upload");
    }
    expect((await putUpload(again.upload, file.bytes)).status).toBe(200);
    const ready = AssetSchema.parse(await (await finalize(asset.id)).json());
    expect(ready.status).toBe("ready");
  });

  it("returns the existing asset for the same project, kind and checksum", async () => {
    const project = await newProject();
    const file = randomFile(1500);
    const first = await startUpload(file, {
      projectId: project.id,
      kind: "poster",
      mime: "image/png",
      filename: "a.png",
    });

    // Still pending: the same asset with a fresh upload URL.
    const pendingAgain = await startUpload(file, {
      projectId: project.id,
      kind: "poster",
      mime: "image/png",
      filename: "b.png",
    });
    expect(pendingAgain.asset.id).toBe(first.asset.id);
    expect(pendingAgain.asset.filename).toBe("a.png");
    expect(pendingAgain.upload).not.toBeNull();

    if (first.upload === null) {
      throw new Error("expected an upload");
    }
    expect((await putUpload(first.upload, file.bytes)).status).toBe(200);
    expect((await finalize(first.asset.id)).status).toBe(200);

    // Ready: nothing to upload.
    const ready = await startUpload(file, {
      projectId: project.id,
      kind: "poster",
      mime: "image/png",
    });
    expect(ready.asset.id).toBe(first.asset.id);
    expect(ready.asset.status).toBe("ready");
    expect(ready.upload).toBeNull();

    // Another kind or another project is another asset.
    const frame = await startUpload(file, {
      projectId: project.id,
      kind: "frame",
      mime: "image/png",
    });
    expect(frame.asset.id).not.toBe(first.asset.id);
    const elsewhere = await newProject();
    const otherProject = await startUpload(file, {
      projectId: elsewhere.id,
      kind: "poster",
      mime: "image/png",
    });
    expect(otherProject.asset.id).not.toBe(first.asset.id);

    const rows = await testDb.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.projectId, project.id), eq(assets.kind, "poster")));
    expect(rows).toHaveLength(1);
  });

  it("dedupes concurrent requests for the same file", async () => {
    const project = await newProject();
    const file = randomFile(512);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        requestUpload(t, { projectId: project.id, bytes: 512, sha256: file.sha256 }),
      ),
    );
    createdKeys.push(assetStorageKey(project.id, "render", file.sha256, "video/mp4"));
    const ids = new Set<string>();
    for (const response of results) {
      expect(response.status).toBe(201);
      ids.add(CreateUploadResponseSchema.parse(await response.json()).asset.id);
    }
    expect(ids.size).toBe(1);
  });

  it("stores a voice take's alignment and refuses one on other kinds", async () => {
    const project = await newProject();
    const voice = randomFile(800);
    const { asset, upload } = await startUpload(voice, {
      projectId: project.id,
      kind: "voice",
      mime: "audio/mpeg",
      filename: "take.mp3",
    });
    if (upload === null) {
      throw new Error("expected an upload");
    }
    expect((await putUpload(upload, voice.bytes)).status).toBe(200);
    const alignment = {
      words: [
        { text: "Hello", startMs: 0, endMs: 300 },
        { text: "world", startMs: 320, endMs: 700 },
      ],
    };
    expect((await finalize(asset.id, { alignment, probe: { durationMs: 700 } })).status).toBe(200);
    const detail = AssetDetailSchema.parse(
      await (await send(t.app, "GET", `/api/assets/${asset.id}`, { cookie })).json(),
    );
    expect(detail.alignment).toEqual(alignment);
    expect(detail.durationMs).toBe(700);

    const render = randomFile(64);
    const other = await startUpload(render, { projectId: project.id });
    const refused = await finalize(other.asset.id, { alignment });
    expect(refused.status).toBe(400);
    expect((await storedRow(other.asset.id))?.status).toBe("pending");
  });

  it("lists an item's assets, newest first and by kind", async () => {
    const project = await newProject();
    const itemId = await newItem(project.id);
    const first = await startUpload(randomFile(32), { projectId: project.id, itemId });
    const second = await startUpload(randomFile(32), {
      projectId: project.id,
      itemId,
      kind: "voice",
      mime: "audio/wav",
      filename: "take.wav",
    });
    await startUpload(randomFile(32), { projectId: project.id });

    const all = await send(t.app, "GET", `/api/content/${itemId}/assets`, { cookie });
    expect(all.status).toBe(200);
    expect(AssetListSchema.parse(await all.json()).items.map((asset) => asset.id)).toEqual([
      second.asset.id,
      first.asset.id,
    ]);

    const voices = await send(t.app, "GET", `/api/content/${itemId}/assets?kind=voice`, { cookie });
    expect(AssetListSchema.parse(await voices.json()).items.map((asset) => asset.id)).toEqual([
      second.asset.id,
    ]);

    const missing = await send(t.app, "GET", `/api/content/${randomUUID()}/assets`, { cookie });
    expect(missing.status).toBe(404);
    const badKind = await send(t.app, "GET", `/api/content/${itemId}/assets?kind=nope`, { cookie });
    expect(badKind.status).toBe(400);
  });

  it("answers 404 for unknown assets", async () => {
    const id = randomUUID();
    expect((await send(t.app, "GET", `/api/assets/${id}`, { cookie })).status).toBe(404);
    expect((await send(t.app, "GET", `/api/assets/${id}/url`, { cookie })).status).toBe(404);
    expect((await finalize(id)).status).toBe(404);
    expect((await send(t.app, "GET", "/api/assets/not-an-id", { cookie })).status).toBe(404);
  });

  it("deletes pending uploads older than a day", async () => {
    const project = await newProject();
    const file = randomFile(256);
    const { asset } = await startUpload(file, { projectId: project.id });
    const key = assetStorageKey(project.id, "render", file.sha256, "video/mp4");
    await plantObject(target, key, file.bytes, "video/mp4");

    await moduleDeps.assets.cleanupPendingUploads();
    expect((await storedRow(asset.id))?.status).toBe("pending");

    const now = t.clock.now();
    t.clock.advance(PENDING_UPLOAD_TTL_MS + 60_000);
    try {
      expect(await moduleDeps.assets.cleanupPendingUploads()).toBeGreaterThanOrEqual(1);
    } finally {
      t.clock.set(now);
    }
    expect(await storedRow(asset.id)).toBeUndefined();
    expect(await moduleDeps.storage.head(key)).toBeNull();
  });
});

describe("finalize on a store that does not record checksums", () => {
  let plain: StorageTarget;
  let app: TestApp;

  beforeAll(async () => {
    plain = await fakeStorageTarget({ recordChecksums: false });
    app = createTestApp(testDb.db, {
      config: { storage: plain.config, assetVerifyMaxBytes: 4096 },
    });
    const user = await insertUser(testDb.db);
    cookies.set(app, (await login(app.app, user.email)).cookie);
  });

  afterAll(async () => {
    await app.deps.lifecycle.close();
    await plain.close();
  });

  it("hashes the stored bytes itself", async () => {
    const project = await newProject();
    const file = randomFile(2048);
    const { asset, upload } = await startUpload(file, { projectId: project.id }, app);
    if (upload === null) {
      throw new Error("expected an upload");
    }
    expect((await putUpload(upload, file.bytes)).status).toBe(200);
    const ready = AssetSchema.parse(await (await finalize(asset.id, {}, app)).json());
    expect(ready.status).toBe("ready");
    const [entry] = await testDb.db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, asset.id), eq(auditLog.action, "asset.finalized")));
    expect(entry?.data).toEqual({ verifiedBy: "hash" });
  });

  it("fails bytes that hash differently, even though the store accepted them", async () => {
    const project = await newProject();
    const file = randomFile(2048);
    const { asset, upload } = await startUpload(file, { projectId: project.id }, app);
    if (upload === null) {
      throw new Error("expected an upload");
    }
    const tampered = Buffer.from(file.bytes);
    tampered[10] = (tampered[10] ?? 0) ^ 0x01;
    expect((await putUpload(upload, tampered)).status).toBe(200);
    const failed = AssetSchema.parse(await (await finalize(asset.id, {}, app)).json());
    expect(failed.status).toBe("failed");
    expect(plain.fake?.objects.size).toBe(1);
  });

  it("fails an upload above the verification cap it cannot check", async () => {
    const project = await newProject();
    const file = randomFile(8192);
    const { asset, upload } = await startUpload(file, { projectId: project.id }, app);
    if (upload === null) {
      throw new Error("expected an upload");
    }
    expect((await putUpload(upload, file.bytes)).status).toBe(200);
    const failed = AssetSchema.parse(await (await finalize(asset.id, {}, app)).json());
    expect(failed.status).toBe("failed");
    const [entry] = await testDb.db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(
        and(eq(auditLog.targetId, asset.id), eq(auditLog.action, "asset.verification_failed")),
      );
    expect(entry?.data).toEqual({ reason: "unverifiable" });
  });
});

describe("without object storage", () => {
  it("answers 503 for uploads and downloads but still reads assets", async () => {
    const app = createTestApp(testDb.db, { config: { storage: null } });
    const user = await insertUser(testDb.db);
    const session = (await login(app.app, user.email)).cookie;
    const project = await newProject();
    const file = randomFile(64);
    const upload = await send(app.app, "POST", "/api/assets/uploads", {
      cookie: session,
      body: {
        projectId: project.id,
        kind: "render",
        filename: "final.mp4",
        mime: "video/mp4",
        bytes: 64,
        sha256: file.sha256,
      },
    });
    expect(upload.status).toBe(503);
    expect(await errorCode(upload)).toBe("storage_unavailable");
    const rows = await testDb.db.select().from(assets).where(eq(assets.projectId, project.id));
    expect(rows).toHaveLength(0);
    const missing = await send(app.app, "GET", `/api/assets/${randomUUID()}`, { cookie: session });
    expect(missing.status).toBe(404);
    await app.deps.lifecycle.close();
  });
});

describe("content security policy", () => {
  function policy(response: Response): Map<string, string[]> {
    const header = response.headers.get("content-security-policy") ?? "";
    return new Map(
      header
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .filter((parts) => parts.length > 0 && parts[0] !== "")
        .map(([name = "", ...values]) => [name, values]),
    );
  }

  async function directivesFor(config: Parameters<typeof createTestApp>[1]) {
    const app = createTestApp(testDb.db, config);
    try {
      return policy(await app.app.request("/healthz"));
    } finally {
      await app.deps.lifecycle.close();
    }
  }

  const r2Like = {
    config: {
      publicBaseUrl: "https://media.example.test/renders",
      storage: {
        ...target.config,
        endpoint: "https://account.r2.example.test",
        publicBaseUrl: "https://media.example.test/renders",
      },
    },
  };

  it("lets presigned uploads and downloads reach the S3 endpoint (connect-src)", async () => {
    expect((await directivesFor(r2Like)).get("connect-src")).toEqual([
      "'self'",
      "https://account.r2.example.test",
      "https://media.example.test",
    ]);
  });

  it("shows images from presigned GETs and the public media host (img-src)", async () => {
    expect((await directivesFor(r2Like)).get("img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://account.r2.example.test",
      "https://media.example.test",
    ]);
  });

  it("plays media from presigned GETs and the public media host (media-src)", async () => {
    const directives = await directivesFor(r2Like);
    expect(directives.get("media-src")).toEqual([
      "'self'",
      "blob:",
      "https://account.r2.example.test",
      "https://media.example.test",
    ]);
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
  });

  it("uses the bucket host with virtual-hosted addressing", async () => {
    const directives = await directivesFor({
      config: {
        storage: {
          ...target.config,
          endpoint: "https://s3.example.test",
          bucket: "media-bucket",
          forcePathStyle: false,
        },
      },
    });
    expect(directives.get("connect-src")).toContain("https://media-bucket.s3.example.test");
  });

  it("allows only the public media host without object storage", async () => {
    const directives = await directivesFor({ config: { storage: null } });
    expect(directives.get("media-src")).toEqual(["'self'", "blob:", "https://media.example.test"]);
    expect(directives.get("connect-src")).toEqual(["'self'", "https://media.example.test"]);
  });
});
