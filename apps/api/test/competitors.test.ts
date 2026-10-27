import { randomUUID } from "node:crypto";
import {
  COMPETITORS_PER_WORKSPACE_MAX,
  type Competitor,
  type CompetitorInsights,
  type CompetitorScan,
  CompetitorScanSchema,
  type CompetitorScanStatus,
  CompetitorSchema,
  competitorTag,
  type JsonObject,
  KbCompetitorReportPayloadSchema,
  KbEntryDetailSchema,
} from "@loomcast/contracts";
import {
  auditLog,
  competitorScans,
  competitors,
  jobs,
  kbEntries,
  kbReferences,
  researchAccounts,
  researchVideos,
  workspaces,
} from "@loomcast/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BUSINESS_DISCOVERY_NOT_FOUND_SUBCODE } from "../src/lib/meta-graph";
import { scanAnalysisKey, scanReportKey } from "../src/modules/competitors";
import { createJobLifecycle, type JobLifecycle } from "../src/modules/jobs/lifecycle";
import { pairDevice, type TestDevice } from "./bridge-support";
import { sampleAnalysis } from "./kb-support";
import {
  answer,
  createOAuthHarness,
  GRAPH_VERSION,
  graphError,
  type OAuthHarness,
  type SeenRequest,
} from "./oauth-support";
import { type InsertedChannel, insertChannel } from "./publisher-support";
import { errorCode, send } from "./support";

let h: OAuthHarness;
let device: TestDevice;
let lifecycle: JobLifecycle;
let channel: InsertedChannel;

beforeAll(async () => {
  h = await createOAuthHarness({ threads: false });
  device = await pairDevice(h.db, h.userId);
  lifecycle = createJobLifecycle({
    db: h.db,
    bus: h.t.bus,
    clock: h.t.clock,
    hooks: h.deps.hooks,
  });
  const keyring = h.t.deps.config.encryption;
  if (keyring === null) {
    throw new Error("the harness has no vault key");
  }
  channel = await insertChannel(h.db, keyring, { platform: "instagram", connected: true });
});

afterEach(() => {
  h.agent.assertNoPendingInterceptors();
});

afterAll(async () => {
  await h.close();
});

function call(method: string, path: string, body?: unknown, cookie = h.cookie) {
  return send(h.t.app, method, path, { cookie, body });
}

async function newWorkspace(status: "active" | "archived" = "active"): Promise<string> {
  const [workspace] = await h.db
    .insert(workspaces)
    .values({
      slug: `competitors-${randomUUID().slice(0, 8)}`,
      name: "Competitors",
      status,
      archivedAt: status === "archived" ? new Date() : null,
      createdBy: h.userId,
    })
    .returning();
  if (workspace === undefined) {
    throw new Error("workspace was not inserted");
  }
  return workspace.id;
}

async function follow(workspaceId: string, url: string): Promise<Competitor> {
  const response = await call("POST", `/api/workspaces/${workspaceId}/competitors`, { url });
  expect(response.status, await response.clone().text()).toBe(201);
  return CompetitorSchema.parse(await response.json());
}

async function startScan(competitorId: string, body: unknown): Promise<CompetitorScan> {
  const response = await call("POST", `/api/competitors/${competitorId}/scans`, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return CompetitorScanSchema.parse(await response.json());
}

async function scanOf(scanId: string): Promise<CompetitorScan> {
  const response = await call("GET", `/api/competitor-scans/${scanId}`);
  expect(response.status).toBe(200);
  return CompetitorScanSchema.parse(await response.json());
}

async function waitForScan(scanId: string, status: CompetitorScanStatus) {
  return vi.waitFor(
    async () => {
      const scan = await scanOf(scanId);
      expect(scan.status).toBe(status);
      return scan;
    },
    { timeout: 5_000, interval: 10 },
  );
}

async function scanRow(scanId: string) {
  const [row] = await h.db.select().from(competitorScans).where(eq(competitorScans.id, scanId));
  if (row === undefined) throw new Error("scan not found");
  return row;
}

async function jobRow(jobId: string) {
  const [row] = await h.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (row === undefined) throw new Error("job not found");
  return row;
}

async function referenceOf(entryId: string) {
  const [row] = await h.db.select().from(kbReferences).where(eq(kbReferences.entryId, entryId));
  if (row === undefined) throw new Error("reference not found");
  return row;
}

async function entryOf(entryId: string) {
  const response = await call("GET", `/api/kb/${entryId}`);
  expect(response.status).toBe(200);
  return KbEntryDetailSchema.parse(await response.json());
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
}

async function fail(jobId: string) {
  await claim(jobId);
  const outcome = await lifecycle.fail(device.deviceId, jobId, {
    code: "download_failed",
    message: "The video could not be downloaded.",
    retryable: false,
  });
  expect(outcome.job?.status).toBe("failed");
}

const MEDIA = { durationMs: 31_000, cutsPerMinute: 14, wordsPerMinute: 160, framesSeen: 6 };

function analysisResult(summary = "Opens on the landing footage."): JsonObject {
  return { analysis: sampleAnalysis(), summaryMd: summary, media: MEDIA } as unknown as JsonObject;
}

const INSIGHTS: CompetitorInsights = {
  positioning: "Space science for curious adults.",
  topics: ["Mars landings", "Telescopes"],
  hookPatterns: ["Footage first, question second"],
  formats: ["Narrated footage"],
  lengthAndPacing: "Around thirty seconds, a cut every four seconds.",
  postingCadence: "Daily.",
  whatWorks: ["Real footage in the first second"],
  opportunities: ["Nobody explains the engineering"],
  recommendations: ["Open on the most striking frame"],
};

function reportResult(): JsonObject {
  return {
    insights: INSIGHTS,
    reportMd: "# @nasa\n\nThe account wins with footage.",
  } as unknown as JsonObject;
}

/** The analysis job ids of a scan's videos, in rank order. */
async function analysisJobs(scanId: string): Promise<string[]> {
  const scan = await scanOf(scanId);
  const ids: string[] = [];
  for (const video of scan.videos) {
    const reference = await referenceOf(video.entryId);
    if (reference.analysisJobId !== null) ids.push(reference.analysisJobId);
  }
  return ids;
}

let reelCounter = 0;
function reelCode(): string {
  reelCounter += 1;
  return `R${randomUUID().replace(/-/g, "").slice(0, 10)}${reelCounter}`;
}

function rawReel(code: string, views: number | undefined, values: JsonObject = {}): JsonObject {
  return {
    id: `id-${code}`,
    media_type: "VIDEO",
    media_product_type: "REELS",
    caption: `Watch ${code} land`,
    like_count: 10,
    comments_count: 2,
    ...(views === undefined ? {} : { view_count: views }),
    timestamp: "2026-09-01T10:00:00+0000",
    permalink: `https://www.instagram.com/reel/${code}/`,
    ...values,
  };
}

function discoveryPage(items: JsonObject[], after?: string) {
  return {
    business_discovery: {
      username: "nasa",
      name: "NASA",
      followers_count: 98_000_000,
      media_count: 4_200,
      media: {
        data: items,
        paging: after === undefined ? {} : { cursors: { after }, next: "https://graph.example" },
      },
    },
    id: channel.externalId,
  };
}

describe("following competitors", () => {
  it("parses profile links and handles, refuses duplicates and lists the competitors", async () => {
    const workspaceId = await newWorkspace();
    const nasa = await follow(workspaceId, "@nasa");
    expect(nasa).toMatchObject({
      workspaceId,
      platform: "instagram",
      handle: "nasa",
      profileUrl: "https://instagram.com/nasa",
      notes: null,
      account: { displayName: null, followersCount: null, mediaCount: null },
      latestScan: null,
      latestReportEntryId: null,
    });
    const page = await follow(workspaceId, "https://www.facebook.com/NASA/");
    expect(page).toMatchObject({ platform: "facebook", handle: "NASA" });
    const threads = await follow(workspaceId, "https://www.threads.net/@nasa");
    expect(threads).toMatchObject({ platform: "threads", profileUrl: "https://threads.net/@nasa" });

    const duplicate = await call("POST", `/api/workspaces/${workspaceId}/competitors`, {
      url: "https://instagram.com/NASA?igsh=abc",
    });
    expect(duplicate.status).toBe(409);
    const body = (await duplicate.json()) as { error: { code: string; details: unknown } };
    expect(body.error).toMatchObject({
      code: "conflict",
      details: { reason: "duplicate", competitorId: nasa.id },
    });

    const listed = await call("GET", `/api/workspaces/${workspaceId}/competitors`);
    expect(listed.status).toBe(200);
    const { items } = (await listed.json()) as { items: Competitor[] };
    expect(items.map((item) => item.id)).toEqual([nasa.id, page.id, threads.id]);

    const audits = await h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "competitor.create"), eq(auditLog.targetId, nasa.id)));
    expect(audits).toHaveLength(1);
  });

  it("refuses links that are not profiles with 400", async () => {
    const workspaceId = await newWorkspace();
    for (const url of [
      "https://instagram.com/reel/abc123/",
      "https://youtube.com/@nasa",
      "https://instagram.com/",
      "ftp://instagram.com/nasa",
    ]) {
      const response = await call("POST", `/api/workspaces/${workspaceId}/competitors`, { url });
      expect(response.status, url).toBe(400);
      expect(await errorCode(response), url).toBe("validation_failed");
    }
  });

  it("updates notes, deletes softly and lets the profile be followed again", async () => {
    const workspaceId = await newWorkspace();
    const nasa = await follow(workspaceId, "nasa");
    const updated = await call("PATCH", `/api/competitors/${nasa.id}`, { notes: "Space footage" });
    expect(updated.status).toBe(200);
    expect(CompetitorSchema.parse(await updated.json()).notes).toBe("Space footage");
    const cleared = await call("PATCH", `/api/competitors/${nasa.id}`, { notes: null });
    expect(CompetitorSchema.parse(await cleared.json()).notes).toBeNull();

    expect((await call("DELETE", `/api/competitors/${nasa.id}`)).status).toBe(204);
    expect((await call("GET", `/api/competitors/${nasa.id}`)).status).toBe(404);
    expect((await call("DELETE", `/api/competitors/${nasa.id}`)).status).toBe(404);
    expect((await call("PATCH", `/api/competitors/${nasa.id}`, { notes: null })).status).toBe(404);
    const again = await follow(workspaceId, "nasa");
    expect(again.id).not.toBe(nasa.id);
    const [row] = await h.db.select().from(competitors).where(eq(competitors.id, nasa.id));
    expect(row?.deletedAt).not.toBeNull();
  });

  it("stops at the per-workspace limit", async () => {
    const workspaceId = await newWorkspace();
    await h.db.insert(competitors).values(
      Array.from({ length: COMPETITORS_PER_WORKSPACE_MAX }, (_, index) => ({
        workspaceId,
        platform: "instagram" as const,
        handle: `account${index}`,
        profileUrl: `https://instagram.com/account${index}`,
      })),
    );
    const response = await call("POST", `/api/workspaces/${workspaceId}/competitors`, {
      url: "nasa",
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { details: unknown } };
    expect(body.error.details).toMatchObject({ reason: "limit" });
  });

  it("checks the workspace and the session", async () => {
    const unknown = randomUUID();
    expect((await call("GET", `/api/workspaces/${unknown}/competitors`)).status).toBe(404);
    expect(
      (await call("POST", `/api/workspaces/${unknown}/competitors`, { url: "nasa" })).status,
    ).toBe(404);
    const archived = await newWorkspace("archived");
    const refused = await call("POST", `/api/workspaces/${archived}/competitors`, { url: "nasa" });
    expect(refused.status).toBe(409);

    const workspaceId = await newWorkspace();
    const nasa = await follow(workspaceId, "nasa");
    for (const [method, path] of [
      ["GET", `/api/workspaces/${workspaceId}/competitors`],
      ["GET", `/api/competitors/${nasa.id}`],
      ["GET", `/api/competitors/${nasa.id}/scans`],
      ["POST", `/api/competitors/${nasa.id}/scans`],
      ["DELETE", `/api/competitors/${nasa.id}`],
    ] as const) {
      const response = await send(h.t.app, method, path, {
        body: method === "POST" ? {} : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    // Every signed-in user of the workspace shares its workspaces.
    const other = await h.otherUser();
    expect((await call("GET", `/api/competitors/${nasa.id}`, undefined, other.cookie)).status).toBe(
      200,
    );
    expect((await call("GET", `/api/competitors/${randomUUID()}`)).status).toBe(404);
    expect((await call("GET", "/api/competitors/not-an-id")).status).toBe(404);
    expect((await call("GET", `/api/competitor-scans/${randomUUID()}`)).status).toBe(404);
  });
});

describe("starting a scan", () => {
  it("needs links for Facebook and Threads and checks every link", async () => {
    const workspaceId = await newWorkspace();
    const page = await follow(workspaceId, "https://facebook.com/nasa");
    const missing = await call("POST", `/api/competitors/${page.id}/scans`, {});
    expect(missing.status).toBe(422);
    expect(await errorCode(missing)).toBe("links_required");

    const bad = await call("POST", `/api/competitors/${page.id}/scans`, {
      links: ["https://facebook.com/reel/123", "https://instagram.com/reel/abc/"],
    });
    expect(bad.status).toBe(422);
    const body = (await bad.json()) as { error: { code: string; details: { path: string }[] } };
    expect(body.error.code).toBe("invalid_link");
    expect(body.error.details.map((issue) => issue.path)).toEqual(["links.1"]);

    const tooMany = await call("POST", `/api/competitors/${page.id}/scans`, { topN: 21 });
    expect(tooMany.status).toBe(400);
    expect(
      await h.db.select().from(competitorScans).where(eq(competitorScans.competitorId, page.id)),
    ).toHaveLength(0);
  });

  it("refuses without a usable Instagram channel", async () => {
    const workspaceId = await newWorkspace();
    const nasa = await follow(workspaceId, "nasa");
    const response = await call("POST", `/api/competitors/${nasa.id}/scans`, {
      channelId: randomUUID(),
    });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("no_instagram_channel");
  });

  it("maps an account that is not professional to 422 not_professional_account", async () => {
    const workspaceId = await newWorkspace();
    const someone = await follow(workspaceId, "@someone.personal");
    answer(h.graph, "GET", `/${GRAPH_VERSION}/${channel.externalId}`, {
      status: 400,
      body: graphError(110, "Invalid user id", BUSINESS_DISCOVERY_NOT_FOUND_SUBCODE),
    });
    const response = await call("POST", `/api/competitors/${someone.id}/scans`, {});
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("not_professional_account");
    const scans = await call("GET", `/api/competitors/${someone.id}/scans`);
    expect(((await scans.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("ranks the account's videos by views across pages and queues their analyses", async () => {
    const workspaceId = await newWorkspace();
    const nasa = await follow(workspaceId, "nasa");
    const codes = Array.from({ length: 6 }, () => reelCode());
    const [c0, c1, c2, c3, c4, c5] = codes as [string, string, string, string, string, string];
    // An earlier, analysed reference of one of the videos is reused without a new job.
    const saved = await call("POST", `/api/workspaces/${workspaceId}/kb`, {
      kind: "reference",
      url: `https://instagram.com/reel/${c3}/`,
      tags: ["saved"],
    });
    expect(saved.status).toBe(201);
    const savedId = KbEntryDetailSchema.parse(await saved.json()).id;
    await h.db
      .update(kbReferences)
      .set({ analysis: sampleAnalysis(), analysisStatus: "done", analyzedAt: new Date() })
      .where(eq(kbReferences.entryId, savedId));

    const seen: SeenRequest[] = [];
    answer(
      h.graph,
      "GET",
      `/${GRAPH_VERSION}/${channel.externalId}`,
      {
        body: discoveryPage(
          [
            rawReel(c0, 100),
            rawReel(c1, 9_000),
            rawReel(`IMG${c2}`, 50_000, { media_type: "IMAGE", media_product_type: "FEED" }),
          ],
          "PAGE2",
        ),
      },
      seen,
    );
    answer(
      h.graph,
      "GET",
      `/${GRAPH_VERSION}/${channel.externalId}`,
      {
        body: discoveryPage([
          rawReel(c3, 20_000),
          rawReel(c4, 500),
          rawReel(c5, 9_000, { like_count: 99 }),
        ]),
      },
      seen,
    );
    const scan = await startScan(nasa.id, { topN: 3 });
    expect(scan).toMatchObject({
      competitorId: nasa.id,
      workspaceId,
      status: "analyzing",
      source: "official_api",
      topN: 3,
      videoCount: 3,
      reportEntryId: null,
      error: null,
      createdBy: h.userId,
    });
    expect(scan.videos.map((video) => [video.rank, video.url, video.metrics.views])).toEqual([
      [1, `https://instagram.com/reel/${c3}/`, 20_000],
      [2, `https://instagram.com/reel/${c5}/`, 9_000],
      [3, `https://instagram.com/reel/${c1}/`, 9_000],
    ]);
    expect(scan.videos.map((video) => video.analysisStatus)).toEqual(["done", "queued", "queued"]);
    expect(scan.videos[0]?.entryId).toBe(savedId);
    expect(scan.videos[1]?.caption).toBe(`Watch ${c5} land`);
    expect(scan.videos[1]?.metrics).toMatchObject({ likes: 99, comments: 2 });

    // The Graph API was asked with the channel's token, never with it in the URL.
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${channel.token}`);
    expect(seen[0]?.query.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]?.query.get("fields")).toContain("business_discovery.username(nasa)");
    expect(seen[1]?.query.get("fields")).toContain(".after(PAGE2)");
    const text = JSON.stringify(scan) + h.t.logs.join("\n");
    expect(text).not.toContain(channel.token ?? "no-token");

    // The account's numbers are kept on the competitor.
    const competitor = CompetitorSchema.parse(
      await (await call("GET", `/api/competitors/${nasa.id}`)).json(),
    );
    expect(competitor.account).toEqual({
      displayName: "NASA",
      followersCount: 98_000_000,
      mediaCount: 4_200,
    });
    expect(competitor.latestScan).toMatchObject({
      id: scan.id,
      status: "analyzing",
      videoCount: 3,
    });

    // Every video the API read is kept in the research data, not only the three analysed.
    const [account] = await h.db
      .select()
      .from(researchAccounts)
      .where(eq(researchAccounts.workspaceId, workspaceId));
    expect(account).toMatchObject({
      platform: "instagram",
      handle: "nasa",
      source: "tracked",
      competitorId: nasa.id,
      followers: 98_000_000,
      medianViews: 9_000,
    });
    const stored = await h.db
      .select({ externalId: researchVideos.externalId, views: researchVideos.views })
      .from(researchVideos)
      .where(eq(researchVideos.workspaceId, workspaceId));
    expect(stored.map((video) => video.externalId).sort()).toEqual([c0, c1, c3, c4, c5].sort());

    // References are tagged; the reused one keeps its own tags and gains the competitor's.
    const tag = competitorTag("instagram", "nasa");
    const reused = await entryOf(savedId);
    expect(reused.tags).toEqual(["saved", "competitor", tag]);
    const fresh = await entryOf(scan.videos[1]?.entryId ?? "");
    expect(fresh).toMatchObject({
      kind: "reference",
      title: `@nasa · Watch ${c5} land`,
      tags: ["competitor", tag],
      reference: { author: "nasa", platform: "instagram", analysisStatus: "queued" },
    });

    // One analysis job per new reference, fetching the public video.
    const jobIds = await analysisJobs(scan.id);
    expect(jobIds).toHaveLength(2);
    for (const [index, jobId] of jobIds.entries()) {
      const job = await jobRow(jobId);
      const entryId = scan.videos[index + 1]?.entryId ?? "";
      expect(job).toMatchObject({
        type: "kb.analyze_reference",
        status: "queued",
        workspaceId,
        idempotencyKey: scanAnalysisKey(scan.id, entryId),
        createdBy: h.userId,
      });
      expect(job.payload).toMatchObject({ entryId, fetchPublicVideo: true, platform: "instagram" });
      expect(job.payload).not.toHaveProperty("transcript");
    }

    // Only one active scan per competitor.
    const again = await call("POST", `/api/competitors/${nasa.id}/scans`, {
      links: [`https://instagram.com/reel/${c0}/`],
    });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("scan_in_progress");

    // Analyses come in: media facts are stored, then the report is queued.
    const [first, second] = jobIds as [string, string];
    await complete(first, analysisResult("First summary."));
    await vi.waitFor(async () => {
      expect((await referenceOf(scan.videos[1]?.entryId ?? "")).mediaFacts).toEqual(MEDIA);
    });
    expect((await scanOf(scan.id)).status).toBe("analyzing");
    await complete(second, analysisResult("Second summary."));
    const reporting = await waitForScan(scan.id, "reporting");
    expect(reporting.videos.map((video) => video.analysisStatus)).toEqual(["done", "done", "done"]);

    const row = await scanRow(scan.id);
    expect(row.reportJobId).not.toBeNull();
    const report = await jobRow(row.reportJobId ?? "");
    expect(report).toMatchObject({
      type: "kb.competitor_report",
      status: "queued",
      idempotencyKey: scanReportKey(scan.id),
    });
    const payload = KbCompetitorReportPayloadSchema.parse(report.payload);
    expect(payload.competitor).toEqual({
      platform: "instagram",
      handle: "nasa",
      displayName: "NASA",
      followersCount: 98_000_000,
      mediaCount: 4_200,
    });
    expect(payload.failedVideos).toBe(0);
    expect(payload.videos.map((video) => [video.rank, video.summaryMd, video.durationMs])).toEqual([
      [1, "", null],
      [2, "First summary.", MEDIA.durationMs],
      [3, "Second summary.", MEDIA.durationMs],
    ]);
    expect(payload.videos[1]?.metrics).toMatchObject({ views: 9_000, likes: 99, comments: 2 });

    // The report becomes a note and the scan is done.
    h.t.clock.set(new Date("2026-10-14T09:00:00Z"));
    await complete(report.id, reportResult());
    const done = await waitForScan(scan.id, "done");
    expect(done.reportEntryId).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    const note = await entryOf(done.reportEntryId ?? "");
    expect(note).toMatchObject({
      kind: "note",
      workspaceId,
      title: "Competitor report: @nasa (2026-10-14)",
      tags: ["competitor", tag, "competitor-report"],
      createdVia: "producer",
      createdBy: h.userId,
    });
    expect(note.bodyMd).toContain("# @nasa\n\nThe account wins with footage.");
    expect(note.bodyMd).toContain("**Positioning.** Space science for curious adults.");
    expect(note.bodyMd).toContain("- Open on the most striking frame");

    const after = CompetitorSchema.parse(
      await (await call("GET", `/api/competitors/${nasa.id}`)).json(),
    );
    expect(after.latestReportEntryId).toBe(done.reportEntryId);
    expect(after.latestScan).toMatchObject({ id: scan.id, status: "done" });
    const scans = await call("GET", `/api/competitors/${nasa.id}/scans`);
    expect(
      ((await scans.json()) as { items: CompetitorScan[] }).items.map((item) => item.id),
    ).toEqual([scan.id]);
  });

  it("falls back to likes and comments when the API refuses view counts", async () => {
    const workspaceId = await newWorkspace();
    const nasa = await follow(workspaceId, "nasa");
    const [low, high] = [reelCode(), reelCode()];
    answer(h.graph, "GET", `/${GRAPH_VERSION}/${channel.externalId}`, {
      status: 400,
      body: graphError(100, "Tried accessing nonexisting field (view_count)"),
    });
    const seen: SeenRequest[] = [];
    answer(
      h.graph,
      "GET",
      `/${GRAPH_VERSION}/${channel.externalId}`,
      {
        body: discoveryPage([
          rawReel(low, undefined, { like_count: 1 }),
          rawReel(high, undefined, { like_count: 500 }),
        ]),
      },
      seen,
    );
    const scan = await startScan(nasa.id, { topN: 1 });
    expect(seen[0]?.query.get("fields")).not.toContain("view_count");
    expect(scan.videos.map((video) => [video.url, video.metrics.views])).toEqual([
      [`https://instagram.com/reel/${high}/`, null],
    ]);
    await call("POST", `/api/competitor-scans/${scan.id}/cancel`);
  });

  it("looks the account up with the workspace's own Instagram channel first", async () => {
    const workspaceId = await newWorkspace();
    const keyring = h.t.deps.config.encryption;
    if (keyring === null) {
      throw new Error("the harness has no vault key");
    }
    // Newer than the shared channel, so it wins only because it belongs to the workspace.
    const own = await insertChannel(h.db, keyring, {
      platform: "instagram",
      connected: true,
      workspaceId,
    });
    const nasa = await follow(workspaceId, "nasa");
    const seen: SeenRequest[] = [];
    answer(
      h.graph,
      "GET",
      `/${GRAPH_VERSION}/${own.externalId}`,
      { body: discoveryPage([rawReel(reelCode(), 10)]) },
      seen,
    );
    const scan = await startScan(nasa.id, { topN: 1 });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${own.token}`);
    await call("POST", `/api/competitor-scans/${scan.id}/cancel`);

    // A channel of another workspace cannot be named.
    const refused = await call("POST", `/api/competitors/${nasa.id}/scans`, {
      topN: 1,
      channelId: channel.id,
    });
    expect(refused.status).toBe(422);
    expect(await errorCode(refused)).toBe("no_instagram_channel");
  });
});

describe("scan outcomes", () => {
  async function linkScan(handle: string, count: number) {
    const workspaceId = await newWorkspace();
    const competitor = await follow(workspaceId, `https://www.threads.net/@${handle}`);
    const links = Array.from(
      { length: count },
      () => `https://www.threads.net/@${handle}/post/${reelCode()}`,
    );
    const scan = await startScan(competitor.id, { links });
    expect(scan).toMatchObject({ source: "links", topN: count, videoCount: count });
    return { workspaceId, competitor, scan, jobIds: await analysisJobs(scan.id) };
  }

  it("is partial when some videos could not be analysed", async () => {
    const { scan, jobIds } = await linkScan("partial.co", 2);
    const [first, second] = jobIds as [string, string];
    await fail(first);
    await vi.waitFor(async () => {
      expect((await scanOf(scan.id)).videos[0]?.analysisStatus).toBe("failed");
    });
    expect((await scanOf(scan.id)).status).toBe("analyzing");
    await complete(second, analysisResult());
    await waitForScan(scan.id, "reporting");
    const row = await scanRow(scan.id);
    const payload = KbCompetitorReportPayloadSchema.parse(
      (await jobRow(row.reportJobId ?? "")).payload,
    );
    expect(payload.failedVideos).toBe(1);
    expect(payload.videos.map((video) => video.rank)).toEqual([2]);
    await complete(row.reportJobId ?? "", reportResult());
    const partial = await waitForScan(scan.id, "partial");
    expect(partial.reportEntryId).not.toBeNull();
  });

  it("queues one report when the last analyses end together", async () => {
    const { scan, jobIds } = await linkScan("together.co", 3);
    await Promise.all(jobIds.map((jobId) => claim(jobId)));
    await Promise.all(
      jobIds.map((jobId) => lifecycle.complete(device.deviceId, jobId, analysisResult())),
    );
    await waitForScan(scan.id, "reporting");
    const reports = await h.db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.type, "kb.competitor_report"), eq(jobs.idempotencyKey, scanReportKey(scan.id))),
      );
    expect(reports).toHaveLength(1);
    expect((await scanRow(scan.id)).reportJobId).toBe(reports[0]?.id);
    await call("POST", `/api/competitor-scans/${scan.id}/cancel`);
  });

  it("fails when no video could be analysed", async () => {
    const { scan, jobIds } = await linkScan("failing.co", 2);
    for (const jobId of jobIds) {
      await fail(jobId);
    }
    const failed = await waitForScan(scan.id, "failed");
    expect(failed.error).toMatchObject({ code: "no_videos_analysed" });
    expect((await scanRow(scan.id)).reportJobId).toBeNull();
  });

  it("fails when the report fails, and ignores a late report", async () => {
    const { scan, jobIds } = await linkScan("report.fails", 1);
    await complete(jobIds[0] ?? "", analysisResult());
    await waitForScan(scan.id, "reporting");
    const reportJobId = (await scanRow(scan.id)).reportJobId ?? "";
    await fail(reportJobId);
    const failed = await waitForScan(scan.id, "failed");
    expect(failed.error).toMatchObject({ code: "download_failed" });
    expect(failed.reportEntryId).toBeNull();
  });

  it("fails when the report does not match the schema", async () => {
    const { scan, jobIds } = await linkScan("report.invalid", 1);
    await complete(jobIds[0] ?? "", analysisResult());
    await waitForScan(scan.id, "reporting");
    const reportJobId = (await scanRow(scan.id)).reportJobId ?? "";
    await claim(reportJobId);
    await lifecycle.complete(device.deviceId, reportJobId, { reportMd: "no insights" });
    const failed = await waitForScan(scan.id, "failed");
    expect(failed.error).toMatchObject({ code: "invalid_result" });
  });

  it("goes straight to the report when every video was analysed before", async () => {
    const { competitor, scan, jobIds } = await linkScan("reused.co", 2);
    for (const jobId of jobIds) {
      await complete(jobId, analysisResult());
    }
    await waitForScan(scan.id, "reporting");
    await call("POST", `/api/competitor-scans/${scan.id}/cancel`);
    const links = scan.videos.map((video) => video.url);
    const second = await startScan(competitor.id, { links });
    expect(second.status).toBe("reporting");
    expect(second.videos.map((video) => video.entryId)).toEqual(
      scan.videos.map((video) => video.entryId),
    );
    expect(await analysisJobs(second.id)).toEqual(jobIds);
    expect((await scanRow(second.id)).reportJobId).not.toBeNull();
    await call("POST", `/api/competitor-scans/${second.id}/cancel`);
  });

  it("cancels a scan and its own jobs", async () => {
    const { competitor, scan, jobIds } = await linkScan("cancel.co", 2);
    const [running, queued] = jobIds as [string, string];
    await claim(running);
    const response = await call("POST", `/api/competitor-scans/${scan.id}/cancel`);
    expect(response.status).toBe(200);
    const cancelled = CompetitorScanSchema.parse(await response.json());
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finishedAt).not.toBeNull();
    expect((await jobRow(queued)).status).toBe("cancelled");
    const runningJob = await jobRow(running);
    expect(runningJob.status).toBe("running");
    expect(runningJob.cancelRequestedAt).not.toBeNull();
    // A late analysis result is stored on the reference but does not revive the scan.
    await lifecycle.complete(device.deviceId, running, analysisResult());
    await vi.waitFor(async () => {
      expect((await scanOf(scan.id)).videos[0]?.analysisStatus).toBe("done");
    });
    expect((await scanOf(scan.id)).status).toBe("cancelled");
    // Cancelling again changes nothing.
    const again = await call("POST", `/api/competitor-scans/${scan.id}/cancel`);
    expect(CompetitorScanSchema.parse(await again.json()).status).toBe("cancelled");
    // A new scan can start.
    const next = await startScan(competitor.id, { links: [scan.videos[1]?.url ?? ""] });
    expect(next.status).toBe("analyzing");
    const audits = await h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "competitor.scan.cancel"), eq(auditLog.targetId, scan.id)));
    expect(audits).toHaveLength(1);
    await call("POST", `/api/competitor-scans/${next.id}/cancel`);
  });

  it("cancels the active scan when the competitor is deleted", async () => {
    const { competitor, scan, jobIds } = await linkScan("deleted.co", 1);
    expect((await call("DELETE", `/api/competitors/${competitor.id}`)).status).toBe(204);
    expect((await scanRow(scan.id)).status).toBe("cancelled");
    expect((await jobRow(jobIds[0] ?? "")).status).toBe("cancelled");
    expect((await call("GET", `/api/competitor-scans/${scan.id}`)).status).toBe(404);
    // The references stay in the knowledge base.
    const [entry] = await h.db
      .select()
      .from(kbEntries)
      .where(eq(kbEntries.id, scan.videos[0]?.entryId ?? ""));
    expect(entry?.deletedAt).toBeNull();
  });
});
