import { type CalendarResponse, generateSlots, type ScheduledPost } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import { layoutEntries, monthOverflow, startTarget } from "@/features/calendar/layout";
import {
  type CalendarQueryKey,
  linkSlots,
  movePost,
  rollbackMove,
  upsertPost,
} from "@/features/calendar/model";
import { CalendarSearchSchema, parseIds } from "@/features/calendar/search";
import {
  calendarPeriod,
  cellInstant,
  periodLabel,
  placeInstant,
  shiftAnchor,
  stepTarget,
  targetInstant,
  WEEK_ROWS,
} from "@/features/calendar/time";
import { calendarSetup } from "./support/calendar";

const HOUR_MS = 60 * 60_000;

function response(posts: ScheduledPost[], slots: CalendarResponse["slots"] = []): CalendarResponse {
  return { posts, slots: linkSlots(posts, slots) };
}

describe("optimistic moves and rollback", () => {
  it("moves a post, frees its slot and takes the slot it lands on", () => {
    const { posts, series, channels } = calendarSetup();
    const next = "2026-10-19T08:00:00.000Z";
    const data = response(
      [posts.moves, posts.logging],
      [
        {
          at: posts.moves.scheduledAt,
          seriesId: series.ownership.id,
          channelId: channels.instagram.id,
        },
        { at: next, seriesId: series.ownership.id, channelId: channels.instagram.id },
      ],
    );
    expect(data.slots[0]?.postId).toBe(posts.moves.id);
    expect(data.slots[1]?.postId).toBeUndefined();

    const moved = movePost(data, posts.moves.id, next);
    expect(moved.posts.find((post) => post.id === posts.moves.id)?.scheduledAt).toBe(next);
    expect(moved.slots[0]?.postId).toBeUndefined();
    expect(moved.slots[1]?.postId).toBe(posts.moves.id);
    // Posts stay in time order, and the original response is untouched.
    expect(moved.posts.map((post) => post.id)).toEqual([posts.logging.id, posts.moves.id]);
    expect(data.posts[0]?.scheduledAt).toBe(posts.moves.scheduledAt);
  });

  it("rolls a failed move back to the post as it was", () => {
    const { posts } = calendarSetup();
    const data = response([posts.moves]);
    const scheduledAt = "2026-10-17T10:00:00.000Z";
    const moved = movePost(data, posts.moves.id, scheduledAt);
    const restored = rollbackMove(moved, { previous: posts.moves, scheduledAt });
    expect(restored.posts).toEqual([posts.moves]);
  });

  it("keeps a newer copy that arrived while the move was saving", () => {
    const { posts } = calendarSetup();
    const scheduledAt = "2026-10-17T10:00:00.000Z";
    const moved = movePost(response([posts.moves]), posts.moves.id, scheduledAt);
    const live = {
      ...posts.moves,
      scheduledAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-14T08:00:01.000Z",
    };
    const key: CalendarQueryKey = {
      from: "2026-10-12T00:00:00.000Z",
      to: "2026-10-19T00:00:00.000Z",
      channelIds: [],
      seriesIds: [],
    };
    const patched = upsertPost(moved, live, key);
    expect(rollbackMove(patched, { previous: posts.moves, scheduledAt })).toBe(patched);
  });

  it("applies live posts by range and filter and ignores older copies", () => {
    const { posts, channels } = calendarSetup();
    const key: CalendarQueryKey = {
      from: "2026-10-12T00:00:00.000Z",
      to: "2026-10-19T00:00:00.000Z",
      channelIds: [channels.instagram.id],
      seriesIds: [],
    };
    const data = response([posts.moves]);
    const later = {
      ...posts.moves,
      scheduledAt: "2026-10-20T08:00:00.000Z",
      updatedAt: "2026-10-14T09:00:00.000Z",
    };
    expect(upsertPost(data, later, key).posts).toEqual([]);
    const older = {
      ...posts.moves,
      scheduledAt: "2026-10-13T08:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    expect(upsertPost(data, older, key)).toBe(data);
    const elsewhere = { ...posts.moves, id: posts.logging.id, channelId: channels.threads.id };
    expect(upsertPost(data, elsewhere, key)).toBe(data);
    const added = upsertPost(response([]), posts.moves, key);
    expect(added.posts).toEqual([posts.moves]);
  });
});

describe("slot mapping across daylight saving time", () => {
  it("covers a 169-hour week when London leaves summer time", () => {
    const period = calendarPeriod("week", "2026-10-22", "Europe/London");
    expect(period.days).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
    expect(period.from).toBe("2026-10-18T23:00:00.000Z");
    expect(period.to).toBe("2026-10-26T00:00:00.000Z");
    expect(Date.parse(period.to) - Date.parse(period.from)).toBe(169 * HOUR_MS);
  });

  it("puts 09:00 cadence slots in the 09:00 row on both sides of the change", () => {
    const zone = "Europe/London";
    const slots = generateSlots(
      { days: ["sat", "sun", "mon"], slots: ["09:00"], tz: zone },
      "2026-10-24T00:00:00.000Z",
      "2026-10-27T00:00:00.000Z",
    ).map((date) => date.toISOString());
    expect(slots).toEqual([
      "2026-10-24T08:00:00.000Z",
      "2026-10-25T09:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
    ]);
    const row = 6; // 06:00 + 6 half hours
    expect(slots.map((slot) => placeInstant(slot, zone))).toEqual([
      { day: "2026-10-24", time: "09:00", row },
      { day: "2026-10-25", time: "09:00", row },
      { day: "2026-10-26", time: "09:00", row },
    ]);
    expect(cellInstant("2026-10-24", row, zone).toISOString()).toBe(slots[0]);
    expect(cellInstant("2026-10-25", row, zone).toISOString()).toBe(slots[1]);
  });

  it("keeps a post's local time when it moves across the spring change in New York", () => {
    const zone = "America/New_York";
    const period = calendarPeriod("week", "2026-03-05", zone);
    expect(Date.parse(period.to) - Date.parse(period.from)).toBe(167 * HOUR_MS);
    // Saturday 7 March 09:15 EST, moved one day on with the keyboard: Sunday 09:15 EDT.
    const scheduledAt = "2026-03-07T14:15:00.000Z";
    const start = startTarget("week", { scheduledAt } as ScheduledPost, period.days, zone);
    expect(start).toEqual({ day: "2026-03-07", row: 6 });
    const next = stepTarget("week", start ?? { day: "", row: 0 }, "ArrowRight", period.days);
    expect(targetInstant(next, scheduledAt, zone).toISOString()).toBe("2026-03-08T13:15:00.000Z");
  });

  it("places a post in the rows of whichever zone the grid follows", () => {
    const at = "2026-10-16T08:00:00.000Z";
    expect(placeInstant(at, "Europe/London")).toEqual({ day: "2026-10-16", time: "09:00", row: 6 });
    expect(placeInstant(at, "Asia/Colombo")).toEqual({ day: "2026-10-16", time: "13:30", row: 15 });
    expect(placeInstant(at, "America/Los_Angeles")).toEqual({
      day: "2026-10-16",
      time: "01:00",
      row: -1,
    });
  });
});

describe("keyboard steps", () => {
  const week = calendarPeriod("week", "2026-10-14", "Europe/London").days;
  const month = calendarPeriod("month", "2026-10-14", "Europe/London").days;

  it("moves by half an hour or a day in a week and stops at its edges", () => {
    expect(stepTarget("week", { day: "2026-10-14", row: 6 }, "ArrowDown", week)).toEqual({
      day: "2026-10-14",
      row: 7,
    });
    expect(stepTarget("week", { day: "2026-10-14", row: 0 }, "ArrowUp", week)).toEqual({
      day: "2026-10-14",
      row: 0,
    });
    expect(
      stepTarget("week", { day: "2026-10-18", row: WEEK_ROWS - 1 }, "ArrowRight", week),
    ).toEqual({ day: "2026-10-18", row: WEEK_ROWS - 1 });
    expect(stepTarget("week", { day: "2026-10-14", row: 6 }, "ArrowLeft", week)).toEqual({
      day: "2026-10-13",
      row: 6,
    });
  });

  it("moves by a day or a week in a month", () => {
    expect(month).toHaveLength(42);
    expect(month[0]).toBe("2026-09-28");
    expect(stepTarget("month", { day: "2026-10-14", row: null }, "ArrowDown", month)).toEqual({
      day: "2026-10-21",
      row: null,
    });
    expect(stepTarget("month", { day: "2026-10-14", row: null }, "ArrowRight", month)).toEqual({
      day: "2026-10-15",
      row: null,
    });
  });
});

describe("month overflow", () => {
  it("shows three entries a day, then the count of the rest", () => {
    const { posts } = calendarSetup();
    const sameDay = Array.from({ length: 5 }, (_, index) => ({
      ...posts.moves,
      id: `${posts.moves.id.slice(0, -2)}0${index}`,
      scheduledAt: `2026-10-16T0${index + 5}:00:00.000Z`,
    }));
    const period = calendarPeriod("month", "2026-10-01", "Europe/London");
    const cells = layoutEntries("month", period.days, response(sameDay), "Europe/London");
    const entries = cells.get("day:2026-10-16") ?? [];
    expect(entries.map((entry) => (entry.kind === "post" ? entry.time : ""))).toEqual([
      "06:00",
      "07:00",
      "08:00",
      "09:00",
      "10:00",
    ]);
    const { shown, hidden } = monthOverflow(entries);
    expect(shown).toHaveLength(3);
    expect(hidden).toBe(2);
    expect(monthOverflow(entries.slice(0, 3))).toEqual({ shown: entries.slice(0, 3), hidden: 0 });
  });

  it("leaves cancelled posts and held slots out", () => {
    const { posts, series, channels } = calendarSetup();
    const cancelled = { ...posts.logging, status: "cancelled" as const };
    const data = response(
      [posts.moves, cancelled],
      [
        {
          at: posts.moves.scheduledAt,
          seriesId: series.ownership.id,
          channelId: channels.instagram.id,
        },
      ],
    );
    const period = calendarPeriod("month", "2026-10-01", "Europe/London");
    const cells = layoutEntries("month", period.days, data, "Europe/London");
    expect([...cells.values()].flat().map((entry) => entry.key)).toEqual([posts.moves.id]);
  });
});

describe("calendar address", () => {
  it("keeps valid values and drops the rest", () => {
    const { channels } = calendarSetup();
    expect(
      CalendarSearchSchema.parse({
        view: "month",
        date: "2026-02-30",
        channels: `${channels.instagram.id},nope,${channels.instagram.id}`,
        zone: "mars",
      }),
    ).toEqual({ view: "month", channels: channels.instagram.id });
    expect(parseIds("")).toEqual([]);
  });

  it("labels and shifts periods", () => {
    const week = calendarPeriod("week", "2026-09-30", "UTC");
    expect(periodLabel(week)).toBe("28 Sep – 4 Oct 2026");
    expect(periodLabel(calendarPeriod("month", "2026-10-14", "UTC"))).toBe("October 2026");
    expect(shiftAnchor("week", "2026-10-14", 1)).toBe("2026-10-21");
    expect(shiftAnchor("month", "2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftAnchor("month", "2026-01-15", -1)).toBe("2025-12-01");
  });
});
