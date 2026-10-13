import type { Cadence, ContentItem, ContentVersion, Series } from "@loomcast/contracts";
import { mockChannel, mockPost } from "@/mocks/calendar";
import { mockContentItem, mockSeries } from "@/mocks/content";
import { createMockDb, MOCK_USER, type MockDb, mockProject } from "@/mocks/db";
import { mockFormat, mockRules } from "@/mocks/formats";
import { onlineStudio } from "./kb";

/** The tests' clock: Wednesday 14 October 2026, 09:00 in London (BST). */
export const CALENDAR_NOW = "2026-10-14T08:00:00.000Z";
/** The browser time zone the calendar tests run in. */
export const CALENDAR_ZONE = "Europe/London";

const CREATED = "2026-10-01T08:00:00.000Z";

/**
 * A signed-in db with two Instagram and Threads channels, two series with cadences in London and
 * a week of posts around `CALENDAR_NOW`:
 * - `moves` queued on Instagram, Friday 16 October 09:00 (its Threads slot is open);
 * - `logging` published on Instagram, Monday 12 October 09:00;
 * - `result` approved without posts; its series has an open Instagram slot Thursday 18:00.
 */
export function calendarSetup() {
  const project = mockProject({ name: "Rust in 60 seconds", slug: "rust-in-60-seconds" });
  const ownership = mockSeries({ projectId: project.id, name: "Ownership basics" });
  const errors = mockSeries({ projectId: project.id, name: "Error handling" });
  const cadenced = (series: Series, cadence: Pick<Cadence, "days" | "slots">) =>
    mockFormat(
      { id: series.formatId, projectId: project.id, name: `${series.name} format` },
      [
        mockRules((rules) => {
          rules.cadence = { ...rules.cadence, ...cadence, tz: CALENDAR_ZONE };
        }),
      ],
      CREATED,
    );
  const formats = [
    cadenced(ownership, { days: ["mon", "wed", "fri"], slots: ["09:00"] }),
    cadenced(errors, { days: ["tue", "thu"], slots: ["18:00"] }),
  ];
  const instagram = mockChannel({
    platform: "instagram",
    displayName: "@rustin60",
    createdAt: CREATED,
  });
  const threads = mockChannel({
    platform: "threads",
    displayName: "Rust threads",
    createdAt: CREATED,
  });

  const versions: ContentVersion[] = [];
  const item = (title: string, extra: Partial<ContentItem>): ContentItem => {
    const created = mockContentItem({
      projectId: project.id,
      title,
      versionNo: 5,
      createdBy: MOCK_USER.id,
      createdAt: CREATED,
      updatedAt: CREATED,
      ...extra,
    });
    versions.push(...created.versions);
    return created.item;
  };
  const moves = item("Moves explained with a cup", {
    state: "scheduled",
    seriesId: ownership.id,
    targetAt: "2026-10-16T08:00:00.000Z",
  });
  const logging = item("What to log when it fails", {
    state: "published",
    seriesId: ownership.id,
    targetAt: "2026-10-12T08:00:00.000Z",
  });
  const result = item("Result is just an enum", { state: "approved", seriesId: errors.id });

  const posts = {
    moves: mockPost({
      item: moves,
      channel: instagram,
      scheduledAt: "2026-10-16T08:00:00.000Z",
      status: "queued",
      createdAt: CREATED,
    }),
    logging: mockPost({
      item: logging,
      channel: instagram,
      scheduledAt: "2026-10-12T08:00:00.000Z",
      status: "published",
      createdAt: CREATED,
    }),
  };

  const db: MockDb = createMockDb({
    signedIn: true,
    projects: [project],
    devices: [onlineStudio()],
    series: [ownership, errors],
    formats: formats.map((entry) => entry.format),
    formatVersions: formats.flatMap((entry) => entry.versions),
    channels: [instagram, threads],
    seriesChannels: [
      {
        seriesId: ownership.id,
        channels: [
          { channelId: instagram.id, enabled: true },
          { channelId: threads.id, enabled: true },
        ],
      },
      { seriesId: errors.id, channels: [{ channelId: instagram.id, enabled: true }] },
    ],
    contentItems: [moves, logging, result],
    contentVersions: versions,
    posts: Object.values(posts),
  });
  return {
    db,
    project,
    series: { ownership, errors },
    channels: { instagram, threads },
    items: { moves, logging, result },
    posts,
  };
}
