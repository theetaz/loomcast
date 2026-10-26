import type {
  ContentItem,
  ContentVersion,
  PipelineState,
  Series,
  Workspace,
} from "@loomcast/contracts";
import { mockContentItem, mockSeries } from "@/mocks/content";
import { createMockDb, MOCK_USER, type MockDb, mockWorkspace } from "@/mocks/db";
import { at, onlineStudio } from "./kb";

export { at };

/**
 * A signed-in db with two workspaces, three series and items across the pipeline. Updated times
 * are spaced a minute apart, newest first in the order below.
 */
export function librarySetup() {
  const rust = mockWorkspace({ name: "Rust in 60 seconds", slug: "rust-in-60-seconds" });
  const agents = mockWorkspace({ name: "Agents for small teams", slug: "agents-for-small-teams" });
  const ownership = mockSeries({ workspaceId: rust.id, name: "Ownership basics" });
  const errors = mockSeries({ workspaceId: rust.id, name: "Error handling" });
  const patterns = mockSeries({ workspaceId: agents.id, name: "Agent patterns" });

  const versions: ContentVersion[] = [];
  let minute = 100;
  const item = (
    workspace: Workspace,
    title: string,
    state: PipelineState,
    extra: Partial<ContentItem> & { series?: Series } = {},
  ): ContentItem => {
    const { series, ...overrides } = extra;
    minute -= 1;
    const created = mockContentItem({
      workspaceId: workspace.id,
      title,
      state,
      versionNo: state === "idea" ? 1 : 3,
      seriesId: series?.id ?? null,
      createdBy: MOCK_USER.id,
      createdAt: at(0),
      updatedAt: at(minute),
      ...overrides,
    });
    versions.push(...created.versions);
    return created.item;
  };

  const borrow = item(rust, "Why the borrow checker rejects this loop", "idea", {
    series: ownership,
    pitch: "Show the error first.",
  });
  const question = item(rust, "The question mark operator", "script", {
    series: errors,
    targetAt: "2026-10-20T09:00:00.000Z",
  });
  const lifetimes = item(rust, "Lifetimes are scopes with names", "render", {
    series: ownership,
    targetAt: "2026-10-18T09:00:00.000Z",
    durationMs: 42_000,
  });
  const moves = item(rust, "Moves explained with a cup", "review", {
    series: ownership,
    targetAt: "2026-10-16T09:00:00.000Z",
    durationMs: 65_000,
  });
  const handoffs = item(agents, "Hand-offs that keep context", "idea", { series: patterns });
  const published = item(agents, "What to log when an agent fails", "published", {
    series: patterns,
    targetAt: "2026-10-02T09:00:00.000Z",
    durationMs: 51_000,
  });
  const archived = item(rust, "Panics in production", "archived");

  const db: MockDb = createMockDb({
    signedIn: true,
    workspaces: [rust, agents],
    devices: [onlineStudio()],
    series: [ownership, errors, patterns],
    contentItems: [borrow, question, lifetimes, moves, handoffs, published, archived],
    contentVersions: versions,
  });
  return {
    db,
    rust,
    agents,
    series: { ownership, errors, patterns },
    items: { borrow, question, lifetimes, moves, handoffs, published, archived },
  };
}
