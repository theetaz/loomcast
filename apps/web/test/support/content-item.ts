import type { ContentItem, ContentVersion, PipelineState } from "@loomcast/contracts";
import type { RequestHandler } from "msw";
import { mockScript } from "@/mocks/artifacts";
import { activeJobs, mockContentItem, mockSeries } from "@/mocks/content";
import { mockJob } from "@/mocks/conversations";
import { createMockDb, MOCK_USER, type MockDb, mockProject } from "@/mocks/db";
import { at, onlineStudio } from "./kb";
import { fakeStream } from "./live";
import { renderApp } from "./render";

/**
 * A signed-in db with one project, one series and an item in each interesting state. The item in
 * review has five versions; its v4 and v5 scripts differ only in the hook.
 */
export function itemSetup() {
  const project = mockProject({ name: "Rust in 60 seconds", slug: "rust-in-60-seconds" });
  const series = mockSeries({ projectId: project.id, name: "Ownership basics" });
  const versions: ContentVersion[] = [];
  const item = (
    title: string,
    state: PipelineState,
    versionNo: number,
    extra: Partial<ContentItem> = {},
  ) => {
    const created = mockContentItem({
      projectId: project.id,
      seriesId: series.id,
      title,
      state,
      versionNo,
      createdBy: MOCK_USER.id,
      createdAt: at(0),
      updatedAt: at(versionNo),
      ...extra,
    });
    versions.push(...created.versions);
    return created;
  };

  const review = item("Moves explained with a cup", "review", 5, { targetAt: at(60 * 24) });
  const [, , , v4, v5] = review.versions as [
    ContentVersion,
    ContentVersion,
    ContentVersion,
    ContentVersion,
    ContentVersion,
  ];
  v4.script = {
    ...mockScript(4, { timed: true }),
    hook: "Rust refuses this loop at compile time.",
  };
  v5.script = {
    ...mockScript(4, { timed: true }),
    hook: "Rust rejects this loop at compile time.",
  };
  const script = item("The question mark operator", "script", 2);
  const published = item("String vs &str, finally", "published", 6);
  const archived = item("Panics in production", "archived", 2);

  const db: MockDb = createMockDb({
    signedIn: true,
    projects: [project],
    devices: [onlineStudio()],
    series: [series],
    contentItems: [review.item, script.item, published.item, archived.item],
    contentVersions: versions,
  });
  return {
    db,
    project,
    series,
    items: {
      review: review.item,
      script: script.item,
      published: published.item,
      archived: archived.item,
    },
    reviewVersions: { v4, v5 },
  };
}

/** Starts a production job on an item, as the API would have it when the page opens. */
export function startJob(db: MockDb, itemId: string) {
  const item = db.contentItems.find((entry) => entry.id === itemId);
  if (!item) throw new Error("No such item.");
  const job = mockJob({
    projectId: item.projectId,
    conversationId: null,
    type: "content.render",
    status: "running",
    maxAttempts: 3,
  });
  db.jobs.push(job);
  activeJobs(db).set(itemId, job.id);
  return job;
}

export function renderItem(
  db: MockDb,
  itemId: string,
  search = "",
  overrides: RequestHandler[] = [],
) {
  const stream = fakeStream(db);
  const view = renderApp(`/content/${itemId}${search}`, db, overrides, {
    createEventSource: stream.factory,
  });
  return { ...view, stream };
}
