import { randomUUID } from "node:crypto";
import {
  type AlignedWord,
  ConversationSchema,
  CreateReviewResponseSchema,
  DEFAULT_FORMAT_RULES,
  FormatSchema,
  getJobDefinition,
  JobSummarySchema,
  type JobType,
  type JsonObject,
  MCP_ACCESS_SCOPES,
  SeriesSchema,
} from "@loomcast/contracts";
import { apiTokens, contentVersions, jobs } from "@loomcast/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { transaction } from "../src/lib/db";
import { contentServiceFor } from "../src/modules/content";
import { createDispatcher } from "../src/modules/jobs/dispatcher";
import { createJobLifecycle, type JobLifecycle } from "../src/modules/jobs/lifecycle";
import { productionServiceFor, stepKey } from "../src/modules/production";
import { pairDevice, type TestDevice } from "./bridge-support";
import {
  call,
  createPipelineHarness,
  insertAsset,
  insertItem,
  insertWorkspace,
  type PipelineHarness,
  script,
  storyboard,
} from "./pipeline-support";
import { errorCode } from "./support";

let h: PipelineHarness;
let workspaceId: string;
let seriesId: string;
let device: TestDevice;
let lifecycle: JobLifecycle;

/** The voice of the test format; not a secret, just the TTS provider's voice name. */
const VOICE_ID = "narrator-test";

beforeAll(async () => {
  h = await createPipelineHarness();
  workspaceId = await insertWorkspace(h);
  const format = await call(h, "POST", `/api/workspaces/${workspaceId}/formats`, {
    name: "Voiced",
    rules: { ...structuredClone(DEFAULT_FORMAT_RULES), voiceId: VOICE_ID, voiceSpeed: 1.1 },
  });
  expect(format.status).toBe(201);
  const formatId = FormatSchema.parse(await format.json()).id;
  const created = await call(h, "POST", `/api/workspaces/${workspaceId}/series`, {
    name: "Voiced series",
    formatId,
  });
  expect(created.status).toBe(201);
  seriesId = SeriesSchema.parse(await created.json()).id;
  device = await pairDevice(h.db, h.userId);
  lifecycle = createJobLifecycle({
    db: h.db,
    bus: h.t.bus,
    clock: h.t.clock,
    hooks: h.deps.hooks,
  });
});

afterAll(async () => {
  await h.close();
});

const content = () => contentServiceFor(h.deps);

async function act(itemId: string, body: Record<string, unknown>) {
  return call(h, "POST", `/api/content/${itemId}/actions`, body);
}

async function started(itemId: string, body: Record<string, unknown>) {
  const response = await act(itemId, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return JobSummarySchema.parse(await response.json());
}

async function jobRow(jobId: string) {
  const [row] = await h.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (row === undefined) throw new Error("job not found");
  return row;
}

async function detail(itemId: string) {
  const found = await content().get(itemId);
  if (found === null) throw new Error("item not found");
  return found;
}

/** Claims a queued job for the test device, as the dispatcher would, and accepts it. */
async function claim(jobId: string) {
  await h.db
    .update(jobs)
    .set({ status: "dispatched", claimedByDevice: device.deviceId, dispatchedAt: new Date() })
    .where(eq(jobs.id, jobId));
  const accepted = await lifecycle.accept(device.deviceId, jobId, 60_000);
  expect(accepted.outcome).toBe("started");
}

async function complete(jobId: string, result: JsonObject) {
  await claim(jobId);
  const outcome = await lifecycle.complete(device.deviceId, jobId, result);
  expect(outcome.job?.status).toBe("succeeded");
  return outcome;
}

/** Word timings of the test script: 400 ms a word and a pause of 600 ms between segments. */
function alignment(): AlignedWord[] {
  const words: AlignedWord[] = [];
  let at = 0;
  script().segments.forEach((segment, index) => {
    if (index > 0) at += 600;
    for (const text of segment.text.split(/\s+/)) {
      words.push({ text, startMs: at, endMs: at + 350 });
      at += 400;
    }
  });
  return words;
}

/** Six words, a pause, nine words: the voice ends at 6.6 s. */
const VOICE_MS = 6_600;

async function resultFor(type: string, itemId: string): Promise<JsonObject> {
  switch (type) {
    case "content.write_script":
      return { script: script(), notes: "Kept it under a minute." };
    case "content.storyboard":
      return { storyboard: storyboard() };
    case "content.voice":
      return {
        voiceAssetId: await insertAsset(h.db, {
          workspaceId,
          itemId,
          kind: "voice",
          durationMs: VOICE_MS,
        }),
        durationMs: VOICE_MS,
        alignment: { words: alignment() },
      };
    case "content.render":
      return {
        renderAssetId: await insertAsset(h.db, {
          workspaceId,
          itemId,
          kind: "render",
          durationMs: 45_000,
        }),
        posterAssetId: await insertAsset(h.db, { workspaceId, itemId, kind: "poster" }),
        durationMs: 45_000,
        width: 1080,
        height: 1920,
      };
    case "content.revise":
      return {
        script: script({ hook: "You have a memory bug you cannot see." }),
        summary: "Sharpened the hook.",
      };
    default:
      throw new Error(`no fake result for ${type}`);
  }
}

/** Runs the item's active production job to success with a fake result; returns its type. */
async function runActive(itemId: string): Promise<string> {
  const active = await content().activeJob(itemId);
  if (active === null) throw new Error("no active job");
  await complete(active.id, await resultFor(active.type, itemId));
  return active.type;
}

describe("content actions", () => {
  it("queues the job each action needs, with the version and the format snapshot", async () => {
    const [idea, scripted, boarded, voiced] = await Promise.all([
      insertItem(h, { workspaceId, seriesId, state: "idea" }),
      insertItem(h, { workspaceId, seriesId, state: "script", level: "script" }),
      insertItem(h, { workspaceId, seriesId, state: "storyboard", level: "storyboard" }),
      insertItem(h, { workspaceId, seriesId, state: "voice", level: "voice" }),
    ]);
    const cases = [
      [idea, "write_script", "content.write_script"],
      [scripted, "storyboard", "content.storyboard"],
      [boarded, "voice", "content.voice"],
      [voiced, "render", "content.render"],
    ] as const;
    for (const [item, action, type] of cases) {
      const job = await started(item.itemId, { action });
      expect(job).toMatchObject({ type, workspaceId, status: "queued" });
      const row = await jobRow(job.id);
      expect(row.idempotencyKey).toBe(stepKey(action, item.itemId, item.versionId));
      expect(row.payload).toMatchObject({
        workspaceId,
        itemId: item.itemId,
        versionId: item.versionId,
        format: { rules: { voiceId: VOICE_ID } },
      });
      expect((row.payload.format as { formatVersionId: string | null }).formatVersionId).not.toBe(
        null,
      );
    }
    const voice = await content().activeJob(boarded.itemId);
    expect(voice?.payload.voice).toEqual({ voiceId: VOICE_ID, speed: 1.1 });
    const render = await content().activeJob(voiced.itemId);
    expect(render?.payload.voiceAssetId).toBe(voiced.voiceAssetId);
  });

  it("starts revise and produce, and produce turns autopilot on", async () => {
    const [scripted, idea] = await Promise.all([
      insertItem(h, { workspaceId, state: "script", level: "script" }),
      insertItem(h, { workspaceId, state: "idea" }),
    ]);
    const revise = await started(scripted.itemId, { action: "revise" });
    expect(revise.type).toBe("content.revise");
    // An item without a series is produced with the default rules.
    expect((await jobRow(revise.id)).payload.format).toEqual({
      formatVersionId: null,
      rules: DEFAULT_FORMAT_RULES,
    });

    const produce = await started(idea.itemId, { action: "produce", through: "voice" });
    expect(produce.type).toBe("content.write_script");
    expect((await detail(idea.itemId)).item.autopilotTarget).toBe("voice");
  });

  it("refuses busy items, missing inputs, a missing voice and finished items", async () => {
    const [busy, scripted, noVoice, approved] = await Promise.all([
      insertItem(h, { workspaceId, state: "idea" }),
      insertItem(h, { workspaceId, state: "script", level: "script" }),
      insertItem(h, { workspaceId, state: "storyboard", level: "storyboard" }),
      insertItem(h, { workspaceId, state: "approved", level: "render" }),
    ]);
    await started(busy.itemId, { action: "write_script" });
    const again = await act(busy.itemId, { action: "write_script" });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("job_in_progress");

    const render = await act(scripted.itemId, { action: "render" });
    expect(render.status).toBe(422);
    expect(await errorCode(render)).toBe("missing_artifact");

    // No series, so the default rules, which have no voice.
    const voice = await act(noVoice.itemId, { action: "voice" });
    expect(voice.status).toBe(422);
    expect(await errorCode(voice)).toBe("voice_not_configured");

    const late = await act(approved.itemId, { action: "write_script" });
    expect(late.status).toBe(409);
    expect(await errorCode(late)).toBe("invalid_transition");

    const unknown = await act(randomUUID(), { action: "write_script" });
    expect(unknown.status).toBe(404);
    const invalid = await act(scripted.itemId, { action: "storyboard", through: "review" });
    expect(invalid.status).toBe(400);
  });

  it("runs a step again under a new key after a failed attempt", async () => {
    const item = await insertItem(h, { workspaceId, state: "idea" });
    const first = await started(item.itemId, { action: "write_script" });
    await claim(first.id);
    await lifecycle.fail(device.deviceId, first.id, {
      code: "producer_failed",
      message: "The producer session stopped.",
      retryable: false,
    });
    const second = await started(item.itemId, { action: "write_script" });
    expect(second.id).not.toBe(first.id);
    expect((await jobRow(second.id)).idempotencyKey).toBe(
      `${stepKey("write_script", item.itemId, item.versionId)}:2`,
    );
  });
});

describe("job results", () => {
  it("turn into one version per job, however often the completion is replayed", async () => {
    const item = await insertItem(h, { workspaceId, state: "idea" });
    const job = await started(item.itemId, { action: "write_script" });
    const result = await resultFor("content.write_script", item.itemId);
    await complete(job.id, result);

    const after = await detail(item.itemId);
    expect(after.item.state).toBe("script");
    expect(after.currentVersion).toMatchObject({
      jobId: job.id,
      createdVia: "job",
      parentVersionId: item.versionId,
      notes: "Kept it under a minute.",
    });

    // 100 replays: 50 completions through the lifecycle and 50 direct hook runs, 10 at a time.
    const row = await jobRow(job.id);
    const hooks = h.deps.hooks["content.write_script"];
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          index % 2 === 0
            ? lifecycle.complete(device.deviceId, job.id, result)
            : transaction(h.db, (tx) => hooks?.onSucceeded?.(tx, row, result) ?? Promise.resolve()),
        ),
      );
    }
    const versions = await h.db
      .select({ id: contentVersions.id })
      .from(contentVersions)
      .where(eq(contentVersions.jobId, job.id));
    expect(versions).toHaveLength(1);
    const again = await detail(item.itemId);
    expect(again.versions).toHaveLength(2);
    expect(again.item.currentVersionId).toBe(after.item.currentVersionId);
  });

  it("time the script and re-time the storyboard to the real voice", async () => {
    const item = await insertItem(h, {
      workspaceId,
      seriesId,
      state: "storyboard",
      level: "storyboard",
    });
    const job = await started(item.itemId, { action: "voice" });
    const result = await resultFor("content.voice", item.itemId);
    await complete(job.id, result);

    const { item: updated, currentVersion } = await detail(item.itemId);
    expect(updated.state).toBe("voice");
    expect(currentVersion.voiceAssetId).toBe(result.voiceAssetId);
    // Segment 1: six words from 0 to 2.35 s; segment 2: nine words from 3 s to 6.55 s.
    expect(currentVersion.script?.segments.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 2_350],
      [3_000, 6_550],
    ]);
    // The storyboard was cut from the 8 s estimate; now it follows the voice and ends with it.
    expect(currentVersion.storyboard?.frames.map((f) => [f.startMs, f.endMs])).toEqual([
      [0, 3_000],
      [3_000, VOICE_MS],
    ]);
  });

  it("re-times a storyboard made after the voice, and flags a render of the wrong length", async () => {
    const item = await insertItem(h, {
      workspaceId,
      seriesId,
      state: "storyboard",
      level: "storyboard",
    });
    await complete(
      (await started(item.itemId, { action: "voice" })).id,
      await resultFor("content.voice", item.itemId),
    );
    // A new storyboard on the voiced version is fitted to the voice too.
    await complete((await started(item.itemId, { action: "storyboard" })).id, {
      storyboard: storyboard(),
    });
    const voiced = await detail(item.itemId);
    expect(voiced.item.state).toBe("voice");
    expect(voiced.currentVersion.storyboard?.frames.at(-1)?.endMs).toBe(VOICE_MS);

    const render = await started(item.itemId, { action: "render" });
    const result = await resultFor("content.render", item.itemId);
    await complete(render.id, { ...result, durationMs: 80_000 });
    const rendered = await detail(item.itemId);
    expect(rendered.item.state).toBe("review");
    expect(rendered.currentVersion.renderAssetId).toBe(result.renderAssetId);
    expect(rendered.currentVersion.notes).toMatch(/runs 80 s, longer than the format's 30–60 s/);
  });

  it("is not used when the item changed while the job ran", async () => {
    const item = await insertItem(h, { workspaceId, state: "script", level: "script" });
    const job = await started(item.itemId, { action: "storyboard" });
    const edited = await call(h, "POST", `/api/content/${item.itemId}/versions`, {
      baseVersionId: item.versionId,
      script: script({ title: "Edited meanwhile" }),
    });
    expect(edited.status).toBe(201);
    await complete(job.id, { storyboard: storyboard() });
    const after = await detail(item.itemId);
    expect(after.currentVersion.storyboard).toBeNull();
    expect(after.item.lastError).toMatchObject({ jobId: job.id, code: "stale_version" });
  });
});

describe("autopilot", () => {
  it("walks an idea through every step to review", async () => {
    const item = await insertItem(h, { workspaceId, seriesId, state: "idea" });
    await started(item.itemId, { action: "produce" });
    expect((await detail(item.itemId)).item.autopilotTarget).toBe("review");

    const steps: string[] = [];
    for (let step = 0; step < 4; step++) {
      steps.push(await runActive(item.itemId));
    }
    expect(steps).toEqual([
      "content.write_script",
      "content.storyboard",
      "content.voice",
      "content.render",
    ]);
    const done = await detail(item.itemId);
    expect(done.item).toMatchObject({ state: "review", autopilotTarget: null, lastError: null });
    expect(done.activeJob).toBeNull();
    expect(done.versions).toHaveLength(5);
  });

  it("stops at the target, and the scheduler's produce joins a running job", async () => {
    const item = await insertItem(h, { workspaceId, seriesId, state: "idea" });
    const production = productionServiceFor(h.deps);
    const first = await production.produce(item.itemId, { through: "storyboard" });
    expect(first.job?.type).toBe("content.write_script");
    expect(first.item.autopilotTarget).toBe("storyboard");
    // Asking again while the step runs keeps the same job.
    const joined = await production.produce(item.itemId, { through: "storyboard" });
    expect(joined.job?.id).toBe(first.job?.id);

    await runActive(item.itemId);
    await runActive(item.itemId);
    const done = await detail(item.itemId);
    expect(done.item).toMatchObject({ state: "storyboard", autopilotTarget: null });
    expect(done.activeJob).toBeNull();
    // Nothing is left up to the target.
    expect((await production.produce(item.itemId, { through: "storyboard" })).job).toBeNull();
  });

  it("stops when a step fails and records the error", async () => {
    const item = await insertItem(h, { workspaceId, seriesId, state: "idea" });
    const job = await started(item.itemId, { action: "produce" });
    await claim(job.id);
    await lifecycle.fail(device.deviceId, job.id, {
      code: "producer_failed",
      message: "The producer session stopped.",
      retryable: false,
    });
    await vi.waitFor(
      async () => {
        const { item: updated } = await detail(item.itemId);
        expect(updated.lastError).toMatchObject({
          jobId: job.id,
          jobType: "content.write_script",
          code: "producer_failed",
        });
        expect(updated.autopilotTarget).toBeNull();
      },
      { timeout: 5_000, interval: 10 },
    );
    expect(
      h.live.some(
        (event) =>
          event.type === "content.item.updated" &&
          event.payload.item.id === item.itemId &&
          event.payload.item.lastError?.jobId === job.id,
      ),
    ).toBe(true);
    expect((await detail(item.itemId)).activeJob).toBeNull();
  });

  it("stops at a missing voice with voice_not_configured", async () => {
    const item = await insertItem(h, { workspaceId, state: "script", level: "script" });
    await started(item.itemId, { action: "produce" });
    await runActive(item.itemId);
    const after = await detail(item.itemId);
    expect(after.item.state).toBe("storyboard");
    expect(after.item.autopilotTarget).toBeNull();
    expect(after.item.lastError?.code).toBe("voice_not_configured");
    expect(after.activeJob).toBeNull();
  });
});

describe("reviews", () => {
  it("queue a revision on request and bring the item back to review", async () => {
    const item = await insertItem(h, { workspaceId, seriesId, state: "review", level: "render" });
    const response = await call(h, "POST", `/api/content/${item.itemId}/reviews`, {
      versionId: item.versionId,
      decision: "request_changes",
      comment: "Open with the bug, not the language.",
    });
    expect(response.status).toBe(201);
    const revise = await vi.waitFor(
      async () => {
        const active = await content().activeJob(item.itemId);
        expect(active?.type).toBe("content.revise");
        return active;
      },
      { timeout: 5_000, interval: 10 },
    );
    expect(revise?.payload).toMatchObject({
      versionId: item.versionId,
      instructions: "Open with the bug, not the language.",
    });
    expect((await detail(item.itemId)).item.autopilotTarget).toBe("review");

    const steps: string[] = [];
    for (let step = 0; step < 4; step++) {
      steps.push(await runActive(item.itemId));
    }
    expect(steps).toEqual([
      "content.revise",
      "content.storyboard",
      "content.voice",
      "content.render",
    ]);
    const done = await detail(item.itemId);
    expect(done.item).toMatchObject({ state: "review", autopilotTarget: null });
    expect(done.currentVersion.script?.hook).toBe("You have a memory bug you cannot see.");
  });

  it("queue nothing when the reviewer asks for no revision", async () => {
    const item = await insertItem(h, { workspaceId, state: "review", level: "render" });
    const response = await call(h, "POST", `/api/content/${item.itemId}/reviews`, {
      versionId: item.versionId,
      decision: "request_changes",
      comment: "I will fix it myself.",
      enqueueRevision: false,
    });
    expect(response.status).toBe(201);
    const { review } = CreateReviewResponseSchema.parse(await response.json());
    expect(review.enqueueRevision).toBe(false);
    const late = await productionServiceFor(h.deps).requestRevision(review);
    expect(late).toBeNull();
    expect(await content().activeJob(item.itemId)).toBeNull();
  });
});

describe("per-item chat", () => {
  it("returns one conversation per item and tells producer.chat the item", async () => {
    const item = await insertItem(h, { workspaceId, state: "idea", title: "Ownership" });
    const [first, second] = await Promise.all([
      call(h, "POST", `/api/content/${item.itemId}/conversation`),
      call(h, "POST", `/api/content/${item.itemId}/conversation`),
    ]);
    expect(first.status).toBe(200);
    const conversation = ConversationSchema.parse(await first.json());
    expect(ConversationSchema.parse(await second.json()).id).toBe(conversation.id);
    expect(conversation).toMatchObject({
      workspaceId,
      title: "Ownership",
      contentItemId: item.itemId,
    });

    const posted = await call(h, "POST", `/api/conversations/${conversation.id}/messages`, {
      text: "Make the hook shorter.",
      clientMessageId: randomUUID(),
    });
    expect(posted.status).toBe(201);
    const { job } = (await posted.json()) as { job: { id: string } };
    expect((await jobRow(job.id)).payload).toMatchObject({
      conversationId: conversation.id,
      contentItemId: item.itemId,
    });

    const missing = await call(h, "POST", `/api/content/${randomUUID()}/conversation`);
    expect(missing.status).toBe(404);
  });
});

describe("job credentials", () => {
  it("are minted for every production job type and skills.sync", async () => {
    // Only the jobs of this test may be claimed.
    await h.db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.status, "queued"));
    const item = await insertItem(h, { workspaceId, state: "voice", level: "voice" });
    const base = {
      workspaceId,
      itemId: item.itemId,
      versionId: item.versionId,
      format: { formatVersionId: null, rules: DEFAULT_FORMAT_RULES },
    };
    const payloads: [JobType, JsonObject][] = [
      ["content.write_script", base],
      ["content.storyboard", base],
      ["content.revise", base],
      ["content.voice", { ...base, voice: { voiceId: VOICE_ID } }],
      ["content.render", { ...base, voiceAssetId: item.voiceAssetId }],
      ["skills.sync", {}],
    ];
    const ids = await transaction(h.db, async (tx) => {
      const created: string[] = [];
      for (const [type, payload] of payloads) {
        const { job } = await h.deps.jobs.enqueue(tx, {
          type,
          payload,
          workspaceId,
          createdBy: h.userId,
        });
        created.push(job.id);
      }
      return created;
    });
    const dispatcher = createDispatcher({
      db: h.db,
      bus: h.t.bus,
      clock: h.t.clock,
      logger: h.t.deps.logger,
      lifecycle,
      sessions: () => [],
    });
    const assignments = await dispatcher.claim({
      deviceId: device.deviceId,
      jobTypes: payloads.map(([type]) => type),
      credits: { producer: 10, render: 10 },
    });
    expect(assignments.map((a) => a.job.id).sort()).toEqual([...ids].sort());
    for (const assignment of assignments) {
      expect(assignment.credentials?.mcp.token).toMatch(/^lc_job_/);
    }
    const tokens = await h.db
      .select({ jobId: apiTokens.jobId, scopes: apiTokens.scopes })
      .from(apiTokens)
      .where(and(inArray(apiTokens.jobId, ids)));
    for (const assignment of assignments) {
      const access = getJobDefinition(assignment.job.type).mcpAccess;
      expect(tokens.find((token) => token.jobId === assignment.job.id)?.scopes).toEqual(
        MCP_ACCESS_SCOPES[access],
      );
    }
  });
});
