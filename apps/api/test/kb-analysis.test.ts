import { randomUUID } from "node:crypto";
import {
  JobSummarySchema,
  KbEntryDetailSchema,
  type LiveEventOf,
  type ReferenceAnalysisStatus,
} from "@loomcast/contracts";
import { auditLog, jobs, kbEntries, projects } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analysisKey } from "../src/modules/kb";
import { type BridgeServer, FakeAgent, pairDevice, startBridgeServer } from "./bridge-support";
import { sampleAnalysis } from "./kb-support";
import { errorCode, insertUser, login, send } from "./support";

let testDb: TestDb;
let server: BridgeServer;
let agent: FakeAgent;
let cookie: string;
let userId: string;
let projectId: string;
let updates: LiveEventOf<"kb.entry.updated">[];

beforeAll(async () => {
  testDb = await createTestDb();
  server = await startBridgeServer(testDb.db);
  updates = [];
  server.bus.subscribe("kb.entry.updated", (event) => {
    updates.push(event);
  });
  const user = await insertUser(testDb.db);
  userId = user.id;
  ({ cookie } = await login(server.app, user.email));
  const [project] = await testDb.db
    .insert(projects)
    .values({ slug: `analysis-${randomUUID().slice(0, 8)}`, name: "Analysis", createdBy: userId })
    .returning();
  if (project === undefined) {
    throw new Error("project was not inserted");
  }
  projectId = project.id;
  const device = await pairDevice(testDb.db, userId);
  agent = await FakeAgent.connect(server.port, { secret: device.secret });
  await agent.hello({ jobTypes: ["kb.analyze_reference"], credits: { producer: 1 } });
});

afterEach(() => {
  // One credit per job: hand it back after every test so the next job is dispatched.
  agent.send({ type: "credits", payload: { producer: 1, render: 1 } });
});

afterAll(async () => {
  await agent.close();
  await server.close();
  await testDb.drop();
});

async function newReference(transcript?: string) {
  const response = await send(server.app, "POST", `/api/projects/${projectId}/kb`, {
    cookie,
    body: {
      kind: "reference",
      url: `https://www.youtube.com/shorts/${randomUUID()}`,
      likedReason: "The question lands before the answer.",
      ...(transcript === undefined ? {} : { transcript }),
    },
  });
  expect(response.status).toBe(201);
  return KbEntryDetailSchema.parse(await response.json());
}

async function analyze(entryId: string) {
  return send(server.app, "POST", `/api/kb/${entryId}/analyze`, { cookie });
}

async function analyzed(entryId: string) {
  const response = await analyze(entryId);
  expect(response.status, await response.clone().text()).toBe(201);
  return JobSummarySchema.parse(await response.json());
}

async function entry(entryId: string) {
  const response = await send(server.app, "GET", `/api/kb/${entryId}`, { cookie });
  expect(response.status).toBe(200);
  return KbEntryDetailSchema.parse(await response.json());
}

async function waitForStatus(entryId: string, status: ReferenceAnalysisStatus) {
  return vi.waitFor(
    async () => {
      const current = await entry(entryId);
      expect(current.reference?.analysisStatus).toBe(status);
      return current;
    },
    { timeout: 5_000, interval: 10 },
  );
}

async function jobStatus(jobId: string) {
  const [row] = await testDb.db.select().from(jobs).where(eq(jobs.id, jobId));
  return row;
}

/** Waits for the assignment of `jobId` and accepts it, as the studio agent does. */
async function acceptAssignment(jobId: string) {
  const assign = await agent.next("job.assign", (message) => message.payload.job.id === jobId);
  expect(assign.payload.job.type).toBe("kb.analyze_reference");
  agent.accept(jobId);
  return assign;
}

describe("reference analysis", () => {
  it("queues the job, follows it to running and stores a valid result", async () => {
    const transcript = "Quick: what happens when you type a URL and press enter?";
    const reference = await newReference(transcript);
    const job = await analyzed(reference.id);
    expect(job).toMatchObject({ type: "kb.analyze_reference", projectId });
    const [row] = await testDb.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.idempotencyKey).toBe(analysisKey(reference.id, transcript));
    expect(row?.payload).toEqual({
      projectId,
      entryId: reference.id,
      url: reference.sourceUrl,
      platform: "youtube",
      transcript,
      likedReason: "The question lands before the answer.",
    });
    const queued = await entry(reference.id);
    expect(queued.reference).toMatchObject({ analysisStatus: "queued", analysisJobId: job.id });

    // Asking again for the same transcript returns the same job.
    expect((await analyzed(reference.id)).id).toBe(job.id);

    const assign = await acceptAssignment(job.id);
    expect(assign.payload.job.payload).toMatchObject({ entryId: reference.id, transcript });
    await waitForStatus(reference.id, "running");

    agent.send({
      type: "job.complete",
      payload: {
        jobId: job.id,
        result: { analysis: sampleAnalysis("Open on a question"), summaryMd: "A question hook." },
      },
    });
    const done = await waitForStatus(reference.id, "done");
    expect(done.reference?.analysis).toEqual(sampleAnalysis("Open on a question"));
    expect(done.reference?.analyzedAt).not.toBeNull();
    expect(done.bodyMd).toBe("A question hook.");
    expect(Date.parse(done.updatedAt)).toBeGreaterThan(Date.parse(reference.updatedAt));
    expect((await jobStatus(job.id))?.status).toBe("succeeded");

    const [stored] = await testDb.db
      .select({ searchExtra: kbEntries.searchExtra })
      .from(kbEntries)
      .where(eq(kbEntries.id, reference.id));
    expect(stored?.searchExtra).toBe(
      ["The question lands before the answer.", transcript, "Open on a question"].join("\n"),
    );
    expect(
      updates.some(
        (event) =>
          event.payload.entry.id === reference.id && event.payload.entry.bodyMd === done.bodyMd,
      ),
    ).toBe(true);
    const audits = await testDb.db
      .select({ action: auditLog.action, actorKind: auditLog.actorKind })
      .from(auditLog)
      .where(and(eq(auditLog.targetType, "kb_entry"), eq(auditLog.targetId, reference.id)))
      .orderBy(auditLog.id);
    expect(audits).toEqual([
      { action: "kb.entry.create", actorKind: "user" },
      { action: "kb.reference.analyze", actorKind: "user" },
      { action: "kb.entry.update", actorKind: "device" },
    ]);

    // The finished analysis is returned again rather than re-run for an unchanged transcript.
    expect((await analyzed(reference.id)).id).toBe(job.id);
  });

  it("rejects a result that fails the schema and marks the analysis failed", async () => {
    const reference = await newReference("Let me draw how a hash map stores keys.");
    const job = await analyzed(reference.id);
    await acceptAssignment(job.id);
    await waitForStatus(reference.id, "running");

    agent.send({
      type: "job.complete",
      payload: {
        jobId: job.id,
        result: { analysis: { ...sampleAnalysis(), takeaways: [] }, summaryMd: "Summary." },
      },
    });
    const failed = await waitForStatus(reference.id, "failed");
    expect(failed.reference?.analysis).toBeNull();
    expect(failed.bodyMd).toBe("");
    const row = await jobStatus(job.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatchObject({ code: "invalid_result" });
  });

  it("marks a failed job failed and runs a retry as a new job", async () => {
    const transcript = "Captions name each command, so it works with the sound off.";
    const reference = await newReference(transcript);
    const job = await analyzed(reference.id);
    await acceptAssignment(job.id);
    await waitForStatus(reference.id, "running");
    agent.send({
      type: "job.fail",
      payload: {
        jobId: job.id,
        error: { code: "internal", message: "The producer session stopped.", retryable: false },
      },
    });
    await waitForStatus(reference.id, "failed");

    agent.send({ type: "credits", payload: { producer: 1, render: 1 } });
    const retry = await analyzed(reference.id);
    expect(retry.id).not.toBe(job.id);
    const [row] = await testDb.db.select().from(jobs).where(eq(jobs.id, retry.id));
    expect(row?.idempotencyKey).toBe(`${analysisKey(reference.id, transcript)}:${job.id}`);
    expect((await entry(reference.id)).reference).toMatchObject({
      analysisStatus: "queued",
      analysisJobId: retry.id,
    });
    // A repeated click on retry still returns the retry.
    expect((await analyzed(reference.id)).id).toBe(retry.id);

    await acceptAssignment(retry.id);
    await waitForStatus(reference.id, "running");
    agent.send({
      type: "job.complete",
      payload: { jobId: retry.id, result: { analysis: sampleAnalysis(), summaryMd: "Captions." } },
    });
    await waitForStatus(reference.id, "done");
  });

  it("ignores the result of an analysis the reference no longer points at", async () => {
    const reference = await newReference("First transcript about DNS.");
    const first = await analyzed(reference.id);
    await acceptAssignment(first.id);
    await waitForStatus(reference.id, "running");

    // The transcript changes while the first analysis runs: the new one replaces it.
    const current = await entry(reference.id);
    const patched = await send(server.app, "PATCH", `/api/kb/${reference.id}`, {
      cookie,
      body: { expectedUpdatedAt: current.updatedAt, transcript: "Second transcript about TCP." },
    });
    expect(patched.status).toBe(200);
    const second = await analyzed(reference.id);
    expect(second.id).not.toBe(first.id);

    agent.send({
      type: "job.complete",
      payload: { jobId: first.id, result: { analysis: sampleAnalysis(), summaryMd: "Old." } },
    });
    await vi.waitFor(async () => expect((await jobStatus(first.id))?.status).toBe("succeeded"));
    const after = await entry(reference.id);
    expect(after.reference).toMatchObject({ analysisStatus: "queued", analysisJobId: second.id });
    expect(after.reference?.analysis).toBeNull();
    expect(after.bodyMd).toBe("");
  });

  it("requires a reference with a transcript", async () => {
    const withoutTranscript = await newReference();
    const missing = await analyze(withoutTranscript.id);
    expect(missing.status).toBe(409);
    expect(await errorCode(missing)).toBe("conflict");

    const note = await send(server.app, "POST", `/api/projects/${projectId}/kb`, {
      cookie,
      body: { kind: "note", title: "Not a reference", bodyMd: "Text" },
    });
    const noteId = KbEntryDetailSchema.parse(await note.json()).id;
    expect((await analyze(noteId)).status).toBe(409);
    expect((await analyze(randomUUID())).status).toBe(404);
    expect((await send(server.app, "POST", `/api/kb/${withoutTranscript.id}/analyze`)).status).toBe(
      401,
    );
  });
});
