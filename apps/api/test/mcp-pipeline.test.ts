import { createHash, randomUUID } from "node:crypto";
import {
  AssetGetUrlOutputSchema,
  ContentCreateIdeaOutputSchema,
  ContentFinalizeAssetOutputSchema,
  ContentGetOutputSchema,
  ContentSubmitForReviewOutputSchema,
  ContentUploadAssetOutputSchema,
  FormatGetRulesOutputSchema,
  pipelineTools,
  type TokenScope,
} from "@loomcast/contracts";
import { assets, auditLog, contentItems, contentVersions, projects } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDeps, ModuleDeps } from "../src/deps";
import { createEventBus } from "../src/lib/bus";
import { transaction } from "../src/lib/db";
import { createLifecycle } from "../src/lib/lifecycle";
import { createLogger } from "../src/lib/logger";
import { contentServiceFor, SYSTEM_ACTOR } from "../src/modules/content";
import { formatsServiceFor } from "../src/modules/formats";
import { TOOL_CALL_AUDIT_ACTION } from "../src/modules/mcp";
import { seriesServiceFor } from "../src/modules/series";
import { type RunningServer, startServer } from "../src/server";
import { connectClient, issueJobToken, issueToken } from "./mcp-support";
import {
  type InsertedItem,
  type ItemSpec,
  insertItem,
  type PipelineHarness,
  script,
  storyboard,
} from "./pipeline-support";
import {
  putUpload,
  randomFile,
  removeObjects,
  resolveStorageTarget,
  type StorageTarget,
} from "./storage-support";
import { createTestClock, insertUser, testConfig } from "./support";

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

const target: StorageTarget = await resolveStorageTarget();

let testDb: TestDb;
let running: RunningServer;
let moduleDeps: ModuleDeps;
let url: URL;
let userId: string;
let writer: Client;
let reader: Client;
let projectA: string;
let projectB: string;
const clients: Client[] = [];
const storedKeys: string[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  const logger = createLogger({ level: "silent" });
  const deps: AppDeps = {
    db: testDb.db,
    bus: createEventBus(logger),
    clock: createTestClock(),
    logger,
    config: testConfig({ trustProxy: false, storage: target.config }),
    lifecycle: createLifecycle(logger),
  };
  running = await startServer(deps, {
    port: 0,
    host: "127.0.0.1",
    modules: [
      (app, captured) => {
        moduleDeps = captured;
        return app;
      },
    ],
  });
  url = new URL("/mcp", `http://127.0.0.1:${running.port}`);
  const user = await insertUser(testDb.db);
  userId = user.id;
  writer = await connectClient(
    url,
    (await issueToken(deps, userId, ["mcp:read", "mcp:write"])).secret,
  );
  reader = await connectClient(url, (await issueToken(deps, userId, ["mcp:read"])).secret);
  projectA = await newProject("Alpha");
  projectB = await newProject("Beta");
});

afterAll(async () => {
  for (const client of [writer, reader, ...clients]) {
    await client?.close();
  }
  await running?.close(1_000);
  await removeObjects(target, target.config.bucket, storedKeys);
  await target.close();
  await testDb?.drop();
});

async function newProject(name: string): Promise<string> {
  const [project] = await testDb.db
    .insert(projects)
    .values({ slug: `mcp-pipeline-${randomUUID().slice(0, 8)}`, name, createdBy: userId })
    .returning();
  if (project === undefined) {
    throw new Error("project was not inserted");
  }
  return project.id;
}

/** A client with the job token of a running job in `projectId`, as a producer session gets one. */
async function jobClient(
  projectId: string,
  scopes: readonly TokenScope[] = ["mcp:read", "mcp:write"],
) {
  const issued = await issueJobToken(testDb.db, { userId, projectId, scopes });
  const client = await connectClient(url, issued.secret);
  clients.push(client);
  return { client, jobId: issued.job.id, tokenId: issued.row.id };
}

/** An item inserted straight into the database, with artifacts up to `level`. */
function item(spec: ItemSpec): Promise<InsertedItem> {
  const h = { db: testDb.db, userId } as unknown as PipelineHarness;
  return insertItem(h, spec);
}

async function seriesIn(projectId: string): Promise<{ seriesId: string; formatId: string }> {
  const actor = { kind: "user", id: userId, userId } as const;
  const format = await formatsServiceFor(moduleDeps).create(
    projectId,
    { name: `Format ${randomUUID().slice(0, 6)}` },
    actor,
  );
  const series = await seriesServiceFor(moduleDeps).create(
    projectId,
    { name: `Series ${randomUUID().slice(0, 6)}`, formatId: format.id },
    actor,
  );
  return { seriesId: series.id, formatId: format.id };
}

function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallResult> {
  return client.callTool({ name, arguments: args });
}

function textOf(result: CallResult): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

function expectOk(result: CallResult): void {
  expect(result.isError, textOf(result)).toBeFalsy();
}

function expectError(result: CallResult, code: string): void {
  expect(result.isError).toBe(true);
  expect(textOf(result).startsWith(`${code}: `), textOf(result)).toBe(true);
  expect(result.structuredContent).toBeUndefined();
}

async function itemRow(id: string) {
  const [row] = await testDb.db.select().from(contentItems).where(eq(contentItems.id, id));
  return row;
}

describe("pipeline tools", () => {
  it("lists every pipeline tool with its job-token policy", async () => {
    const { tools } = await reader.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of Object.keys(pipelineTools)) {
      expect(names).toContain(name);
    }
    const publish = tools.find((tool) => tool.name === "skill.publish");
    expect(publish?.annotations?.readOnlyHint).toBe(false);
    const get = tools.find((tool) => tool.name === "content.get");
    expect(get?.annotations?.readOnlyHint).toBe(true);
  });

  describe("format.get_rules", () => {
    it("returns the current rules of a series' format", async () => {
      const { seriesId, formatId } = await seriesIn(projectA);
      const result = await call(reader, "format.get_rules", { seriesId });
      expectOk(result);
      const output = FormatGetRulesOutputSchema.parse(result.structuredContent);
      expect(output.formatId).toBe(formatId);
      expect(output.version).toBe(1);
      expect(textOf(result)).toContain(output.formatVersionId);

      const job = await jobClient(projectA, ["mcp:read"]);
      expectOk(await call(job.client, "format.get_rules", { seriesId }));
    });

    it("refuses a series of another project to a job token, and unknown series", async () => {
      const { seriesId } = await seriesIn(projectB);
      const job = await jobClient(projectA);
      expectError(await call(job.client, "format.get_rules", { seriesId }), "forbidden");
      expectError(await call(reader, "format.get_rules", { seriesId: randomUUID() }), "not_found");
    });
  });

  describe("content.create_idea", () => {
    it("creates an idea marked mcp for user tokens and producer for job tokens", async () => {
      const result = await call(writer, "content.create_idea", {
        projectId: projectA,
        title: "Borrow checker in 60 seconds",
        pitch: "Why the compiler says no",
      });
      expectOk(result);
      const { itemId } = ContentCreateIdeaOutputSchema.parse(result.structuredContent);
      const row = await itemRow(itemId);
      expect(row?.state).toBe("idea");
      expect(row?.createdVia).toBe("mcp");
      expect(row?.createdBy).toBe(userId);

      const { seriesId } = await seriesIn(projectA);
      const job = await jobClient(projectA);
      const fromJob = await call(job.client, "content.create_idea", {
        projectId: projectA,
        seriesId,
        title: "Lifetimes without tears",
        pitch: "Annotations are promises, not commands",
        topic: "rust",
      });
      expectOk(fromJob);
      const jobRow = await itemRow(
        ContentCreateIdeaOutputSchema.parse(fromJob.structuredContent).itemId,
      );
      expect(jobRow?.createdVia).toBe("producer");
      expect(jobRow?.seriesId).toBe(seriesId);
    });

    it("refuses another project to a job token and read-only tokens", async () => {
      const job = await jobClient(projectA);
      const before = await testDb.db
        .select({ id: contentItems.id })
        .from(contentItems)
        .where(eq(contentItems.projectId, projectB));
      const args = { projectId: projectB, title: "Elsewhere", pitch: "Not yours" };
      expectError(await call(job.client, "content.create_idea", args), "forbidden");
      expectError(await call(reader, "content.create_idea", args), "forbidden");
      const after = await testDb.db
        .select({ id: contentItems.id })
        .from(contentItems)
        .where(eq(contentItems.projectId, projectB));
      expect(after).toHaveLength(before.length);
    });
  });

  describe("content.get", () => {
    it("returns the item, a version with its artifacts and the format", async () => {
      const { seriesId } = await seriesIn(projectA);
      const inserted = await item({
        projectId: projectA,
        seriesId,
        state: "voice",
        level: "voice",
      });
      const job = await jobClient(projectA, ["mcp:read"]);

      const current = await call(job.client, "content.get", { itemId: inserted.itemId });
      expectOk(current);
      const output = ContentGetOutputSchema.parse(current.structuredContent);
      expect(output.item.id).toBe(inserted.itemId);
      expect(output.version.id).toBe(inserted.versionId);
      expect(output.version.versionNo).toBe(2);
      expect(output.version.script).toEqual(script());
      expect(output.version.storyboard).toEqual(storyboard());
      expect(output.version.voiceAssetId).toBe(inserted.voiceAssetId);
      expect(output.format?.formatVersionId).toEqual(expect.any(String));

      expect(output.item.currentVersionId).toBe(inserted.versionId);
      const [v1] = await testDb.db
        .select({ id: contentVersions.id })
        .from(contentVersions)
        .where(and(eq(contentVersions.itemId, inserted.itemId), eq(contentVersions.versionNo, 1)));
      const older = await call(job.client, "content.get", {
        itemId: inserted.itemId,
        versionId: v1?.id,
      });
      expectOk(older);
      const old = ContentGetOutputSchema.parse(older.structuredContent);
      expect(old.version.versionNo).toBe(1);
      expect(old.version.script).toBeNull();
    });

    it("is bound to the job's project and reports unknown records", async () => {
      const other = await item({ projectId: projectB });
      const job = await jobClient(projectA, ["mcp:read"]);
      expectError(await call(job.client, "content.get", { itemId: other.itemId }), "forbidden");
      expectError(await call(reader, "content.get", { itemId: randomUUID() }), "not_found");
      expectError(
        await call(reader, "content.get", { itemId: other.itemId, versionId: randomUUID() }),
        "not_found",
      );
      // The refusal is audited with the job.
      const rows = await testDb.db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, TOOL_CALL_AUDIT_ACTION), eq(auditLog.targetId, "content.get")),
        );
      expect(
        rows.some((row) => row.data?.outcome === "denied" && row.data?.jobId === job.jobId),
      ).toBe(true);
    });

    it("has no format for an item without a series", async () => {
      const inserted = await item({ projectId: projectA });
      const result = await call(reader, "content.get", { itemId: inserted.itemId });
      expectOk(result);
      expect(ContentGetOutputSchema.parse(result.structuredContent).format).toBeNull();
    });
  });

  describe("content.submit_for_review", () => {
    it("writes a version and moves the item to the stage its artifacts reach", async () => {
      const inserted = await item({ projectId: projectA });
      const job = await jobClient(projectA);
      const result = await call(job.client, "content.submit_for_review", {
        itemId: inserted.itemId,
        baseVersionId: inserted.versionId,
        script: script(),
      });
      expectOk(result);
      const output = ContentSubmitForReviewOutputSchema.parse(result.structuredContent);
      expect(output).toMatchObject({ versionNo: 2, state: "script" });

      const both = await call(writer, "content.submit_for_review", {
        itemId: inserted.itemId,
        baseVersionId: output.versionId,
        storyboard: storyboard(),
        notes: "Tighter hook",
      });
      expectOk(both);
      expect(ContentSubmitForReviewOutputSchema.parse(both.structuredContent)).toMatchObject({
        versionNo: 3,
        state: "storyboard",
      });
      expect((await itemRow(inserted.itemId))?.state).toBe("storyboard");
    });

    it("refuses a stale base version", async () => {
      const inserted = await item({ projectId: projectA, state: "script", level: "script" });
      const result = await call(writer, "content.submit_for_review", {
        itemId: inserted.itemId,
        baseVersionId: randomUUID(),
        storyboard: storyboard(),
      });
      expectError(result, "conflict");
      expect((await itemRow(inserted.itemId))?.currentVersionId).toBe(inserted.versionId);
    });

    it("never lets a token approve or edit an approved item", async () => {
      const approved = await item({ projectId: projectA, state: "approved", level: "render" });
      const job = await jobClient(projectA);
      const result = await call(job.client, "content.submit_for_review", {
        itemId: approved.itemId,
        script: script({ hook: "A different hook." }),
      });
      expectError(result, "invalid_transition");
      expect((await itemRow(approved.itemId))?.state).toBe("approved");

      // A caption change in review is a user's move only.
      const inReview = await item({ projectId: projectA, state: "review", level: "render" });
      expectError(
        await call(job.client, "content.submit_for_review", {
          itemId: inReview.itemId,
          storyboard: storyboard(),
          caption: "New caption",
        }),
        "invalid_transition",
      );
      expect((await itemRow(inReview.itemId))?.state).toBe("review");
    });

    it("refuses an item of another project to a job token", async () => {
      const other = await item({ projectId: projectB });
      const job = await jobClient(projectA);
      expectError(
        await call(job.client, "content.submit_for_review", {
          itemId: other.itemId,
          script: script(),
        }),
        "forbidden",
      );
      expect((await itemRow(other.itemId))?.currentVersionId).toBe(other.versionId);
    });
  });
});

describe("asset tools", () => {
  function voiceFile(size = 2_048) {
    const file = randomFile(size);
    return {
      file,
      args: {
        kind: "voice",
        filename: "voice.mp3",
        mime: "audio/mpeg",
        bytes: file.bytes.length,
        sha256: file.sha256,
      },
    };
  }

  async function storageKeyOf(assetId: string): Promise<string> {
    const [row] = await testDb.db.select().from(assets).where(eq(assets.id, assetId));
    if (row === undefined) {
      throw new Error("asset not found");
    }
    storedKeys.push(row.storageKey);
    return row.storageKey;
  }

  it("uploads, finalizes and downloads a voice take with a job token", async () => {
    const inserted = await item({ projectId: projectA, state: "storyboard", level: "storyboard" });
    const job = await jobClient(projectA);
    const { file, args } = voiceFile();

    const started = await call(job.client, "content.upload_asset", {
      itemId: inserted.itemId,
      ...args,
    });
    expectOk(started);
    const { asset, upload } = ContentUploadAssetOutputSchema.parse(started.structuredContent);
    await storageKeyOf(asset.id);
    expect(asset).toMatchObject({
      status: "pending",
      itemId: inserted.itemId,
      projectId: projectA,
    });
    expect(upload).not.toBeNull();
    if (upload === null) return;

    // Finalizing before the bytes are stored is an upload_missing error the agent can retry.
    const early = await call(job.client, "content.finalize_asset", { assetId: asset.id });
    expectError(early, "upload_missing");

    const put = await putUpload(upload, file.bytes);
    expect(put.status).toBe(200);
    const alignment = {
      words: [
        { text: "Every", startMs: 0, endMs: 300 },
        { text: "value", startMs: 300, endMs: 700 },
      ],
    };
    const finalized = await call(job.client, "content.finalize_asset", {
      assetId: asset.id,
      probe: { durationMs: 31_000, audioCodec: "mp3" },
      alignment,
    });
    expectOk(finalized);
    const ready = ContentFinalizeAssetOutputSchema.parse(finalized.structuredContent).asset;
    expect(ready).toMatchObject({ status: "ready", durationMs: 31_000 });
    const [row] = await testDb.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(row?.createdByJob).toBe(job.jobId);

    const link = await call(job.client, "asset.get_url", { assetId: asset.id });
    expectOk(link);
    const output = AssetGetUrlOutputSchema.parse(link.structuredContent);
    expect(output.asset).toMatchObject({
      id: asset.id,
      kind: "voice",
      status: "ready",
      itemId: inserted.itemId,
      projectId: projectA,
      sha256: file.sha256,
      durationMs: 31_000,
      alignment,
    });
    const download = await fetch(output.url);
    expect(download.status).toBe(200);
    const body = Buffer.from(await download.arrayBuffer());
    expect(createHash("sha256").update(body).digest("hex")).toBe(file.sha256);

    // The same file again needs no upload.
    const again = await call(job.client, "content.upload_asset", {
      itemId: inserted.itemId,
      ...args,
    });
    expectOk(again);
    const repeated = ContentUploadAssetOutputSchema.parse(again.structuredContent);
    expect(repeated.upload).toBeNull();
    expect(repeated.asset.id).toBe(asset.id);
    expect(textOf(again)).toContain("no upload needed");
  });

  it("gives two items their own copies of an identical voice take and render", async () => {
    const content = contentServiceFor(moduleDeps);
    const items = [
      await item({ projectId: projectA, state: "storyboard", level: "storyboard" }),
      await item({ projectId: projectA, state: "storyboard", level: "storyboard" }),
    ];
    const job = await jobClient(projectA);
    const voice = voiceFile(1_024);
    const render = randomFile(1_536);
    const files = [
      { field: "voiceAssetId", file: voice.file, args: voice.args },
      {
        field: "renderAssetId",
        file: render,
        args: {
          kind: "render",
          filename: "final.mp4",
          mime: "video/mp4",
          bytes: render.bytes.length,
          sha256: render.sha256,
        },
      },
    ] as const;

    for (const { field, file, args } of files) {
      const ids: string[] = [];
      for (const { itemId } of items) {
        const started = await call(job.client, "content.upload_asset", { itemId, ...args });
        expectOk(started);
        const { asset, upload } = ContentUploadAssetOutputSchema.parse(started.structuredContent);
        await storageKeyOf(asset.id);
        expect(asset.itemId).toBe(itemId);
        // Never the other item's asset, so the bytes go up once per item.
        expect(ids).not.toContain(asset.id);
        expect(upload).not.toBeNull();
        if (upload === null) return;
        expect((await putUpload(upload, file.bytes)).status).toBe(200);
        expectOk(await call(job.client, "content.finalize_asset", { assetId: asset.id }));
        ids.push(asset.id);

        // The item's next version may use it, as a production job's result does.
        const result = await transaction(testDb.db, (tx) =>
          content.createVersion(tx, itemId, { [field]: asset.id }, SYSTEM_ACTOR),
        );
        expect(result.version[field]).toBe(asset.id);
      }

      // Each item still deduplicates its own upload.
      for (const [index, { itemId }] of items.entries()) {
        const again = await call(job.client, "content.upload_asset", { itemId, ...args });
        expectOk(again);
        const repeated = ContentUploadAssetOutputSchema.parse(again.structuredContent);
        expect(repeated.asset.id).toBe(ids[index]);
        expect(repeated.upload).toBeNull();
      }
    }
  });

  it("reports a pending asset as not ready and unknown assets as not found", async () => {
    const inserted = await item({ projectId: projectA });
    const { args } = voiceFile(512);
    const started = await call(writer, "content.upload_asset", {
      itemId: inserted.itemId,
      ...args,
    });
    expectOk(started);
    const { asset } = ContentUploadAssetOutputSchema.parse(started.structuredContent);
    await storageKeyOf(asset.id);
    expectError(await call(reader, "asset.get_url", { assetId: asset.id }), "not_ready");
    expectError(await call(reader, "asset.get_url", { assetId: randomUUID() }), "not_found");
    expectError(
      await call(writer, "content.finalize_asset", { assetId: randomUUID() }),
      "not_found",
    );
    expectError(
      await call(writer, "content.upload_asset", { itemId: randomUUID(), ...args }),
      "not_found",
    );
  });

  it("binds uploads, finalization and downloads to the job's project", async () => {
    const other = await item({ projectId: projectB, state: "voice", level: "voice" });
    const job = await jobClient(projectA);
    const { args } = voiceFile(256);
    expectError(
      await call(job.client, "content.upload_asset", { itemId: other.itemId, ...args }),
      "forbidden",
    );
    const voiceAssetId = other.voiceAssetId ?? "";
    expectError(await call(job.client, "asset.get_url", { assetId: voiceAssetId }), "forbidden");
    expectError(
      await call(job.client, "content.finalize_asset", { assetId: voiceAssetId }),
      "forbidden",
    );
    const pending = await testDb.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.itemId, other.itemId), eq(assets.status, "pending")));
    expect(pending).toEqual([]);
  });

  it("refuses uploads to read-only job tokens", async () => {
    const inserted = await item({ projectId: projectA });
    const job = await jobClient(projectA, ["mcp:read"]);
    const { args } = voiceFile(128);
    expectError(
      await call(job.client, "content.upload_asset", { itemId: inserted.itemId, ...args }),
      "forbidden",
    );
  });
});
