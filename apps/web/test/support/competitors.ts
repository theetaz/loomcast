import type { CompetitorScan, KbEntryDetail } from "@loomcast/contracts";
import { mockChannel } from "@/mocks/calendar";
import {
  mockCompetitor,
  mockCompetitorReference,
  mockCompetitorReport,
  mockCompetitorScan,
} from "@/mocks/competitors";
import { createMockDb, MOCK_USER, type MockDb, mockProject } from "@/mocks/db";
import { onlineStudio } from "./kb";

export const COMPETITORS_PROJECT_SLUG = "rust-in-60-seconds";

const CREATED = "2026-10-01T08:00:00.000Z";
const SCANNED = "2026-10-10T08:00:00.000Z";

/**
 * A signed-in db with one project, a connected Instagram channel and three competitors:
 * - `fastrust` on Instagram (248.3K followers), with a finished scan of three videos and a report;
 * - `rustaceans`, a Facebook Page, never scanned;
 * - `ferris_daily` on Threads, with a scan of two videos still analysing (one done).
 */
export function competitorsSetup() {
  const project = mockProject({ name: "Rust in 60 seconds", slug: COMPETITORS_PROJECT_SLUG });
  const instagram = mockChannel({
    platform: "instagram",
    displayName: "@rustin60",
    connected: true,
    status: "active",
    createdAt: CREATED,
  });

  const fastrust = mockCompetitor({
    projectId: project.id,
    platform: "instagram",
    handle: "fastrust",
    account: { displayName: "Fast Rust", followersCount: 248_300, mediaCount: 412 },
    createdAt: "2026-10-03T08:00:00.000Z",
  });
  const page = mockCompetitor({
    projectId: project.id,
    platform: "facebook",
    handle: "rustaceans",
    createdAt: "2026-10-02T08:00:00.000Z",
  });
  const threads = mockCompetitor({
    projectId: project.id,
    platform: "threads",
    handle: "ferris_daily",
    createdAt: CREATED,
  });

  const entries: KbEntryDetail[] = [];
  const reference = (
    handle: string,
    platform: "instagram" | "threads",
    url: string,
    caption: string | null,
    analysisStatus: "done" | "failed" | "running" | "queued",
  ) => {
    const entry = mockCompetitorReference({
      projectId: project.id,
      platform,
      handle,
      url,
      caption,
      analysisStatus,
      createdAt: SCANNED,
    });
    entries.push(entry);
    return entry;
  };

  const doneVideos = [
    reference(
      "fastrust",
      "instagram",
      "https://www.instagram.com/reel/AAA111/",
      "This one line breaks every Rust beginner.",
      "done",
    ),
    reference(
      "fastrust",
      "instagram",
      "https://www.instagram.com/reel/BBB222/",
      "Option vs Result in 40 seconds.",
      "done",
    ),
    reference("fastrust", "instagram", "https://www.instagram.com/reel/CCC333/", null, "failed"),
  ];
  const report = mockCompetitorReport({
    projectId: project.id,
    platform: "instagram",
    handle: "fastrust",
    at: "2026-10-10T09:00:00.000Z",
  });
  entries.push(report);
  const views = [1_480_000, 652_000, 12_400];
  const finished = mockCompetitorScan({
    competitorId: fastrust.id,
    projectId: project.id,
    status: "partial",
    topN: 3,
    createdAt: SCANNED,
    finishedAt: "2026-10-10T09:00:00.000Z",
    reportEntryId: report.id,
    createdBy: MOCK_USER.id,
    error: { code: "some_failed", message: "1 video could not be downloaded." },
    videos: doneVideos.map((entry, index) => ({
      rank: index + 1,
      entryId: entry.id,
      url: entry.reference?.url ?? "",
      caption: entry.bodyMd || null,
      metrics: {
        views: views[index] ?? null,
        likes: Math.round((views[index] ?? 0) * 0.06),
        comments: 120 - index * 40,
        postedAt: "2026-09-20T08:00:00.000Z",
      },
      analysisStatus: entry.reference?.analysisStatus ?? "done",
    })),
  });

  const activeVideos = [
    reference(
      "ferris_daily",
      "threads",
      "https://www.threads.net/@ferris_daily/post/XYZ1",
      "Borrowing, drawn.",
      "done",
    ),
    reference(
      "ferris_daily",
      "threads",
      "https://www.threads.net/@ferris_daily/post/XYZ2",
      null,
      "running",
    ),
  ];
  const active: CompetitorScan = mockCompetitorScan({
    competitorId: threads.id,
    projectId: project.id,
    status: "analyzing",
    source: "links",
    topN: 2,
    createdAt: "2026-10-14T07:50:00.000Z",
    createdBy: MOCK_USER.id,
    videos: activeVideos.map((entry, index) => ({
      rank: index + 1,
      entryId: entry.id,
      url: entry.reference?.url ?? "",
      caption: entry.bodyMd || null,
      metrics: { views: null, likes: null, comments: null, postedAt: null },
      analysisStatus: entry.reference?.analysisStatus ?? "queued",
    })),
  });

  const db: MockDb = createMockDb({
    signedIn: true,
    projects: [project],
    devices: [onlineStudio()],
    channels: [instagram],
    kbEntries: entries,
    competitors: [fastrust, page, threads],
    competitorScans: [active, finished],
  });
  return {
    db,
    project,
    competitors: { fastrust, page, threads },
    scans: { finished, active },
    report,
    videos: { done: doneVideos, active: activeVideos },
  };
}
