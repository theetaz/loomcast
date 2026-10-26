import {
  ACTIVE_COMPETITOR_SCAN_STATUSES,
  type ApiError,
  COMPETITOR_SCAN_DEFAULT_VIDEOS,
  COMPETITORS_PER_WORKSPACE_MAX,
  type Competitor,
  type CompetitorPlatform,
  type CompetitorScan,
  type CompetitorScanStatus,
  type CompetitorScanSummary,
  type CompetitorScanVideo,
  CompetitorUrlError,
  type CompetitorVideoMetrics,
  CreateCompetitorRequestSchema,
  CreateCompetitorScanRequestSchema,
  competitorTag,
  isPublicVideoUrl,
  type KbEntryDetail,
  parseCompetitorUrl,
  type ReferenceAnalysisStatus,
  routes,
  UpdateCompetitorRequestSchema,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import { type MockDb, mockId, publish } from "./db";
import { DEMO_ANALYSIS, listedEntry, mockKbEntry, mockReferenceDetail, updateKbEntry } from "./kb";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json<ApiError>(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");
const competitorNotFound = () => apiError(404, "not_found", "No competitor has that id.");
const scanNotFound = () => apiError(404, "not_found", "No competitor scan has that id.");

const PLATFORM_NAMES: Record<CompetitorPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
};

export function isActiveScan(status: CompetitorScanStatus): boolean {
  return (ACTIVE_COMPETITOR_SCAN_STATUSES as readonly CompetitorScanStatus[]).includes(status);
}

export function mockCompetitor(
  overrides: Partial<Competitor> & Pick<Competitor, "workspaceId" | "platform" | "handle">,
): Competitor {
  const at = overrides.createdAt ?? new Date().toISOString();
  const { profileUrl } = parseCompetitorUrl(
    overrides.platform === "instagram"
      ? `@${overrides.handle}`
      : overrides.platform === "facebook"
        ? `https://facebook.com/${overrides.handle}`
        : `https://threads.net/@${overrides.handle}`,
  );
  return {
    id: mockId(),
    profileUrl,
    notes: null,
    account: { displayName: null, followersCount: null, mediaCount: null },
    latestScan: null,
    latestReportEntryId: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

export function mockCompetitorScan(
  overrides: Partial<CompetitorScan> &
    Pick<CompetitorScan, "competitorId" | "workspaceId" | "status">,
): CompetitorScan {
  const at = overrides.createdAt ?? new Date().toISOString();
  const videos = overrides.videos ?? [];
  return {
    id: mockId(),
    source: "official_api",
    videoCount: videos.length,
    createdAt: at,
    finishedAt: isActiveScan(overrides.status) ? null : at,
    topN: COMPETITOR_SCAN_DEFAULT_VIDEOS,
    videos,
    reportEntryId: null,
    error: null,
    createdBy: null,
    ...overrides,
  };
}

/** A reference entry for one competitor video, tagged like the server tags them. */
export function mockCompetitorReference(input: {
  workspaceId: string;
  platform: CompetitorPlatform;
  handle: string;
  url: string;
  caption: string | null;
  analysisStatus: ReferenceAnalysisStatus;
  createdAt?: string;
}): KbEntryDetail {
  const done = input.analysisStatus === "done";
  return mockKbEntry({
    workspaceId: input.workspaceId,
    kind: "reference",
    title: `${PLATFORM_NAMES[input.platform]} video by @${input.handle}`,
    tags: ["competitor", competitorTag(input.platform, input.handle)],
    sourceUrl: input.url,
    bodyMd: input.caption ?? "",
    createdVia: "producer",
    ...(input.createdAt ? { createdAt: input.createdAt, updatedAt: input.createdAt } : {}),
    reference: mockReferenceDetail({
      url: input.url,
      platform: input.platform,
      author: `@${input.handle}`,
      analysisStatus: input.analysisStatus,
      analysis: done ? DEMO_ANALYSIS : null,
      analyzedAt: done ? (input.createdAt ?? new Date().toISOString()) : null,
    }),
  });
}

/** The report note a finished scan leaves in the knowledge base. */
export function mockCompetitorReport(input: {
  workspaceId: string;
  platform: CompetitorPlatform;
  handle: string;
  at?: string;
}): KbEntryDetail {
  const at = input.at ?? new Date().toISOString();
  const day = new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(Date.parse(at));
  return mockKbEntry({
    workspaceId: input.workspaceId,
    kind: "note",
    title: `Competitor report: @${input.handle} (${day})`,
    tags: ["competitor", competitorTag(input.platform, input.handle), "competitor-report"],
    createdVia: "producer",
    createdAt: at,
    updatedAt: at,
    bodyMd: [
      `## @${input.handle} in short`,
      "",
      "Short tutorials that open on a broken line of code and fix it on screen in under a minute.",
      "",
      "## What works",
      "",
      "- Hooks that show the error before any words.",
      "- One idea per video, closed with the fixed code running.",
      "- Captions in the lower third, never more than two lines.",
      "",
      "## Opportunities",
      "",
      "- Nobody covers lifetimes with real-world examples.",
      "- Longer follow-ups (60 to 90 s) get fewer views but more saves.",
    ].join("\n"),
  });
}

const SAMPLE_CAPTIONS = [
  "This one line breaks every Rust beginner. Here's why the borrow checker is right.",
  "Stop cloning everything: three ways to share data without a copy.",
  "Option vs Result in 40 seconds.",
  "The trait trick senior devs use to clean up their APIs.",
  "Why your async function never runs (and the one-word fix).",
  "Lifetimes explained with a library card.",
  "Iterators are faster than loops? Let's measure.",
  "Pattern matching you didn't know about.",
  "Error handling with the ? operator, from zero.",
  "Smart pointers in one minute: Box, Rc and Arc.",
];

/** Numbers that fall with rank, so the table reads like a real top list. */
function sampleMetrics(rank: number, postedAt: string): CompetitorVideoMetrics {
  const views = Math.round(1_480_000 / rank ** 1.15);
  return {
    views,
    likes: Math.round(views * 0.061),
    comments: Math.round(views * 0.0042),
    postedAt,
  };
}

function scanSummary(scan: CompetitorScan): CompetitorScanSummary {
  return {
    id: scan.id,
    status: scan.status,
    source: scan.source,
    videoCount: scan.videoCount,
    createdAt: scan.createdAt,
    finishedAt: scan.finishedAt,
  };
}

/** A scan as the API returns it: each video's analysis status read from its reference. */
export function scanView(db: MockDb, scan: CompetitorScan): CompetitorScan {
  return {
    ...scan,
    videos: scan.videos.map((video) => {
      const entry = db.kbEntries.find((item) => item.id === video.entryId);
      return { ...video, analysisStatus: entry?.reference?.analysisStatus ?? video.analysisStatus };
    }),
  };
}

function scansOf(db: MockDb, competitorId: string): CompetitorScan[] {
  return db.competitorScans
    .filter((scan) => scan.competitorId === competitorId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A competitor as the API returns it, with its latest scan and report. */
export function competitorView(db: MockDb, competitor: Competitor): Competitor {
  const scans = scansOf(db, competitor.id);
  const latest = scans[0];
  return {
    ...competitor,
    latestScan: latest ? scanSummary(latest) : null,
    latestReportEntryId: scans.find((scan) => scan.reportEntryId)?.reportEntryId ?? null,
  };
}

function finish(db: MockDb, scan: CompetitorScan) {
  const statuses = scan.videos.map(
    (video) =>
      db.kbEntries.find((entry) => entry.id === video.entryId)?.reference?.analysisStatus ??
      video.analysisStatus,
  );
  const failed = statuses.filter((status) => status === "failed").length;
  const competitor = db.competitors.find((item) => item.id === scan.competitorId);
  if (!competitor || failed === statuses.length) {
    scan.status = "failed";
    scan.error = {
      code: "all_analyses_failed",
      message: "None of the videos could be analysed, so no report was written.",
    };
  } else {
    const report = mockCompetitorReport({
      workspaceId: scan.workspaceId,
      platform: competitor.platform,
      handle: competitor.handle,
    });
    db.kbEntries.push(report);
    publish(db, { type: "kb.entry.created", payload: { entry: listedEntry(report) } });
    scan.reportEntryId = report.id;
    scan.status = failed > 0 ? "partial" : "done";
  }
  scan.finishedAt = new Date().toISOString();
}

const scanTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

/** Mock mode: plays a scan through its analyses and report, one video every 1.5 s. */
function simulateScan(db: MockDb, scan: CompetitorScan) {
  if (!db.simulateProducer) return;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const step = 1_500;
  scan.videos.forEach((video, index) => {
    timers.push(
      setTimeout(() => {
        if (scan.status !== "analyzing") return;
        updateKbEntry(db, video.entryId, (entry) => {
          if (entry.reference) entry.reference.analysisStatus = "running";
        });
      }, index * step),
      setTimeout(
        () => {
          if (scan.status !== "analyzing") return;
          updateKbEntry(db, video.entryId, (entry) => {
            if (!entry.reference) return;
            // One video in seven fails, as a private or removed video would.
            const failed = video.rank % 7 === 0;
            entry.reference.analysisStatus = failed ? "failed" : "done";
            entry.reference.analysis = failed ? null : DEMO_ANALYSIS;
            entry.reference.analyzedAt = failed ? null : new Date().toISOString();
          });
        },
        index * step + step,
      ),
    );
  });
  const analysed = scan.videos.length * step + step;
  timers.push(
    setTimeout(() => {
      if (scan.status === "analyzing") scan.status = "reporting";
    }, analysed),
    setTimeout(() => {
      if (scan.status === "reporting") finish(db, scan);
      scanTimers.delete(scan.id);
    }, analysed + 4_000),
  );
  scanTimers.set(scan.id, timers);
}

function stopScan(scanId: string) {
  for (const timer of scanTimers.get(scanId) ?? []) clearTimeout(timer);
  scanTimers.delete(scanId);
}

function hasInstagramChannel(db: MockDb): boolean {
  return db.channels.some(
    (channel) =>
      channel.platform === "instagram" && channel.connected && channel.status === "active",
  );
}

/** Picks a scan's videos and gives each one a reference entry, reusing entries by URL. */
function pickVideos(
  db: MockDb,
  competitor: Competitor,
  urls: { url: string; caption: string | null; metrics: CompetitorVideoMetrics }[],
): CompetitorScanVideo[] {
  return urls.map((video, index) => {
    let entry = db.kbEntries.find(
      (item) => item.workspaceId === competitor.workspaceId && item.reference?.url === video.url,
    );
    if (!entry) {
      entry = mockCompetitorReference({
        workspaceId: competitor.workspaceId,
        platform: competitor.platform,
        handle: competitor.handle,
        url: video.url,
        caption: video.caption,
        analysisStatus: "queued",
      });
      db.kbEntries.push(entry);
      publish(db, { type: "kb.entry.created", payload: { entry: listedEntry(entry) } });
    } else if (entry.reference && entry.reference.analysisStatus !== "done") {
      entry.reference.analysisStatus = "queued";
    }
    return {
      rank: index + 1,
      entryId: entry.id,
      url: video.url,
      caption: video.caption,
      metrics: video.metrics,
      analysisStatus: entry.reference?.analysisStatus ?? "queued",
    };
  });
}

/** Handlers for the competitor routes, following `@loomcast/contracts`. */
export function createCompetitorHandlers(db: MockDb) {
  const findCompetitor = (id: unknown) => db.competitors.find((item) => item.id === id);

  return [
    http.get(path("competitors.list"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const items = db.competitors
        .filter((item) => item.workspaceId === params.workspaceId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((item) => competitorView(db, item));
      return HttpResponse.json({ items });
    }),

    http.post(path("competitors.create"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const workspace = db.workspaces.find((item) => item.id === params.workspaceId);
      if (!workspace) return apiError(404, "not_found", "No workspace has that id.");
      const parsed = CreateCompetitorRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) return apiError(400, "validation_failed", "Check the profile link.");
      let profile: ReturnType<typeof parseCompetitorUrl>;
      try {
        profile = parseCompetitorUrl(parsed.data.url);
      } catch (error) {
        if (error instanceof CompetitorUrlError) {
          return apiError(400, "validation_failed", error.message);
        }
        throw error;
      }
      const followed = db.competitors.filter((item) => item.workspaceId === workspace.id);
      if (
        followed.some(
          (item) =>
            item.platform === profile.platform &&
            item.handle.toLowerCase() === profile.handle.toLowerCase(),
        )
      ) {
        return apiError(409, "conflict", "The workspace already follows this profile.", {
          reason: "duplicate",
        });
      }
      if (followed.length >= COMPETITORS_PER_WORKSPACE_MAX) {
        return apiError(
          422,
          "limit_reached",
          `A workspace follows at most ${COMPETITORS_PER_WORKSPACE_MAX} competitors.`,
        );
      }
      const competitor = mockCompetitor({
        workspaceId: workspace.id,
        platform: profile.platform,
        handle: profile.handle,
        notes: parsed.data.notes || null,
      });
      db.competitors.push(competitor);
      return HttpResponse.json(competitorView(db, competitor), { status: 201 });
    }),

    http.get(path("competitors.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const competitor = findCompetitor(params.id);
      return competitor ? HttpResponse.json(competitorView(db, competitor)) : competitorNotFound();
    }),

    http.patch(path("competitors.update"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const competitor = findCompetitor(params.id);
      if (!competitor) return competitorNotFound();
      const parsed = UpdateCompetitorRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) return apiError(400, "validation_failed", "Check the notes.");
      competitor.notes = parsed.data.notes || null;
      competitor.updatedAt = new Date().toISOString();
      return HttpResponse.json(competitorView(db, competitor));
    }),

    http.delete(path("competitors.delete"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const competitor = findCompetitor(params.id);
      if (!competitor) return competitorNotFound();
      for (const scan of scansOf(db, competitor.id)) stopScan(scan.id);
      db.competitors = db.competitors.filter((item) => item.id !== competitor.id);
      db.competitorScans = db.competitorScans.filter((scan) => scan.competitorId !== competitor.id);
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(path("competitors.scans"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const competitor = findCompetitor(params.id);
      if (!competitor) return competitorNotFound();
      return HttpResponse.json({
        items: scansOf(db, competitor.id).map((scan) => scanView(db, scan)),
      });
    }),

    http.post(path("competitors.scan"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const competitor = findCompetitor(params.id);
      if (!competitor) return competitorNotFound();
      const parsed = CreateCompetitorScanRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) return apiError(400, "validation_failed", "Check the scan settings.");
      if (scansOf(db, competitor.id).some((scan) => isActiveScan(scan.status))) {
        return apiError(409, "scan_in_progress", "A scan of this competitor is already running.");
      }
      const { topN, links } = parsed.data;
      const now = Date.now();
      let picked: { url: string; caption: string | null; metrics: CompetitorVideoMetrics }[];
      if (links) {
        const bad = links.find((link) => !isPublicVideoUrl(link, competitor.platform));
        if (bad) {
          return apiError(
            400,
            "validation_failed",
            `Not a public ${PLATFORM_NAMES[competitor.platform]} video link: ${bad}`,
          );
        }
        picked = links.map((url) => ({
          url,
          caption: null,
          metrics: { views: null, likes: null, comments: null, postedAt: null },
        }));
      } else {
        if (competitor.platform !== "instagram") {
          return apiError(
            422,
            "links_required",
            `${PLATFORM_NAMES[competitor.platform]} scans need links to the videos.`,
          );
        }
        if (!hasInstagramChannel(db)) {
          return apiError(
            422,
            "no_instagram_channel",
            "Connect an Instagram channel to rank videos by views.",
          );
        }
        // The demo stands in for a personal account with handles that mention one.
        if (competitor.handle.toLowerCase().includes("personal")) {
          return apiError(
            422,
            "not_professional_account",
            "This account is not a business or creator account.",
          );
        }
        picked = Array.from({ length: topN }, (_, index) => ({
          url: `https://www.instagram.com/reel/${competitor.handle.slice(0, 6)}${index + 1}${mockId().slice(0, 6)}/`,
          caption: SAMPLE_CAPTIONS[index % SAMPLE_CAPTIONS.length] ?? null,
          metrics: sampleMetrics(
            index + 1,
            new Date(now - (index * 5 + 3) * 24 * 60 * 60_000).toISOString(),
          ),
        }));
        competitor.account = {
          displayName: competitor.account.displayName ?? competitor.handle,
          followersCount: competitor.account.followersCount ?? 248_300,
          mediaCount: competitor.account.mediaCount ?? 412,
        };
      }
      const scan = mockCompetitorScan({
        competitorId: competitor.id,
        workspaceId: competitor.workspaceId,
        status: "analyzing",
        source: links ? "links" : "official_api",
        topN: links ? Math.min(links.length, topN) : topN,
        videos: pickVideos(db, competitor, picked),
        createdBy: db.user.id,
        createdAt: new Date(now).toISOString(),
      });
      db.competitorScans.unshift(scan);
      simulateScan(db, scan);
      return HttpResponse.json(scanView(db, scan), { status: 201 });
    }),

    http.get(path("competitorScans.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const scan = db.competitorScans.find((item) => item.id === params.id);
      return scan ? HttpResponse.json(scanView(db, scan)) : scanNotFound();
    }),

    http.post(path("competitorScans.cancel"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const scan = db.competitorScans.find((item) => item.id === params.id);
      if (!scan) return scanNotFound();
      if (!isActiveScan(scan.status)) {
        return apiError(409, "conflict", "The scan has already finished.");
      }
      stopScan(scan.id);
      scan.status = "cancelled";
      scan.finishedAt = new Date().toISOString();
      for (const video of scan.videos) {
        updateKbEntry(db, video.entryId, (entry) => {
          const reference = entry.reference;
          if (
            reference &&
            (reference.analysisStatus === "queued" || reference.analysisStatus === "running")
          ) {
            reference.analysisStatus = "none";
          }
        });
      }
      return HttpResponse.json(scanView(db, scan));
    }),
  ];
}

/**
 * Mock mode: two competitors of the first workspace. `@fastrust` on Instagram has a finished scan
 * with a report; `rustaceans` on Facebook has none yet.
 */
export function seedCompetitorDemo(db: MockDb, now: number) {
  const workspace = db.workspaces[0];
  if (!workspace) return;
  const at = (days: number) => new Date(now - days * 24 * 60 * 60_000).toISOString();
  const fastrust = mockCompetitor({
    workspaceId: workspace.id,
    platform: "instagram",
    handle: "fastrust",
    notes: "Closest competitor: same audience, posts daily.",
    account: { displayName: "Fast Rust", followersCount: 248_300, mediaCount: 412 },
    createdAt: at(6),
    updatedAt: at(6),
  });
  const page = mockCompetitor({
    workspaceId: workspace.id,
    platform: "facebook",
    handle: "rustaceans",
    createdAt: at(2),
    updatedAt: at(2),
  });
  db.competitors.push(fastrust, page);

  const scannedAt = at(5);
  const entries = SAMPLE_CAPTIONS.slice(0, 8).map((caption, index) =>
    mockCompetitorReference({
      workspaceId: workspace.id,
      platform: "instagram",
      handle: fastrust.handle,
      url: `https://www.instagram.com/reel/fr${index + 1}demo/`,
      caption,
      analysisStatus: index === 6 ? "failed" : "done",
      createdAt: scannedAt,
    }),
  );
  const report = mockCompetitorReport({
    workspaceId: workspace.id,
    platform: "instagram",
    handle: fastrust.handle,
    at: at(5),
  });
  db.kbEntries.push(...entries, report);
  db.competitorScans.push(
    mockCompetitorScan({
      competitorId: fastrust.id,
      workspaceId: workspace.id,
      status: "partial",
      topN: 8,
      createdAt: scannedAt,
      finishedAt: at(5),
      reportEntryId: report.id,
      createdBy: db.user.id,
      videos: entries.map((entry, index) => ({
        rank: index + 1,
        entryId: entry.id,
        url: entry.reference?.url ?? "",
        caption: entry.bodyMd,
        metrics: sampleMetrics(index + 1, at(9 + index * 4)),
        analysisStatus: entry.reference?.analysisStatus ?? "done",
      })),
    }),
  );
}
