import { describe, expect, it } from "vitest";
import {
  type Cadence,
  CalendarQuerySchema,
  calendarTools,
  DEFAULT_FORMAT_RULES,
  effectivePublishMode,
  fromLocalDateTime,
  generateSlots,
  MAX_CALENDAR_RANGE_DAYS,
  MAX_CALENDAR_RANGE_MS,
  PUBLISH_MODES,
  type PublishMode,
  toLocalDateTime,
} from "../src";

type SlotCadence = Pick<Cadence, "days" | "slots" | "tz">;

const iso = (cadence: SlotCadence, from: string, to: string) =>
  generateSlots(cadence, from, to).map((slot) => slot.toISOString());

describe("cadence slots in New York", () => {
  const tz = "America/New_York";

  it("moves a slot the clocks skip to the first valid minute (spring forward)", () => {
    // 2026-03-08: at 02:00 EST the clocks jump to 03:00 EDT (07:00 UTC).
    const cadence: SlotCadence = { days: ["sat", "sun", "mon"], slots: ["01:30", "02:30"], tz };

    expect(iso(cadence, "2026-03-07T00:00:00.000Z", "2026-03-10T00:00:00.000Z")).toEqual([
      "2026-03-07T06:30:00.000Z", // Sat 01:30 EST
      "2026-03-07T07:30:00.000Z", // Sat 02:30 EST
      "2026-03-08T06:30:00.000Z", // Sun 01:30 EST
      "2026-03-08T07:00:00.000Z", // Sun 02:30 does not exist: 03:00 EDT
      "2026-03-09T05:30:00.000Z", // Mon 01:30 EDT
      "2026-03-09T06:30:00.000Z", // Mon 02:30 EDT
    ]);
  });

  it("keeps one slot when several skipped times move to the same minute", () => {
    const cadence: SlotCadence = { days: ["sun"], slots: ["02:00", "02:15", "02:59", "03:00"], tz };

    expect(iso(cadence, "2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z")).toEqual([
      "2026-03-08T07:00:00.000Z",
    ]);
  });

  it("takes the earlier instant of a time that happens twice (fall back)", () => {
    // 2026-11-01: at 02:00 EDT the clocks go back to 01:00 EST (06:00 UTC), so 01:30 happens at
    // 05:30 UTC (EDT) and again at 06:30 UTC (EST).
    const cadence: SlotCadence = { days: ["sat", "sun", "mon"], slots: ["01:30", "09:00"], tz };

    expect(iso(cadence, "2026-10-31T00:00:00.000Z", "2026-11-03T00:00:00.000Z")).toEqual([
      "2026-10-31T05:30:00.000Z", // Sat 01:30 EDT
      "2026-10-31T13:00:00.000Z", // Sat 09:00 EDT
      "2026-11-01T05:30:00.000Z", // Sun 01:30, the first time (EDT)
      "2026-11-01T14:00:00.000Z", // Sun 09:00 EST
      "2026-11-02T06:30:00.000Z", // Mon 01:30 EST
      "2026-11-02T14:00:00.000Z", // Mon 09:00 EST
    ]);
  });

  it("keeps the local time of every slot across both changes", () => {
    const cadence: SlotCadence = {
      days: ["mon", "wed", "fri", "sun"],
      slots: ["00:00", "09:00", "18:30", "23:59"],
      tz,
    };
    // Local midnight 2026-02-20 (a Friday) to local midnight 2026-04-20: 59 local days, of which
    // 34 are Mondays, Wednesdays, Fridays or Sundays, with four slots each.
    const slots = generateSlots(
      cadence,
      fromLocalDateTime("2026-02-20", "00:00", tz),
      fromLocalDateTime("2026-04-20", "00:00", tz),
    );

    expect(slots).toHaveLength(34 * 4);
    for (const slot of slots) {
      const local = toLocalDateTime(slot, tz);
      expect(cadence.days).toContain(local.weekday);
      expect(cadence.slots).toContain(local.time);
    }
    const autumn = generateSlots(cadence, "2026-10-01T00:00:00.000Z", "2026-11-30T00:00:00.000Z");
    for (const slot of autumn) expect(cadence.slots).toContain(toLocalDateTime(slot, tz).time);
  });
});

describe("cadence slots elsewhere", () => {
  it("uses the half-hour offset of Asia/Colombo and its local weekdays", () => {
    const cadence: SlotCadence = {
      days: ["mon"],
      slots: ["00:15", "09:00", "23:45"],
      tz: "Asia/Colombo",
    };

    // Monday 00:15 in Colombo is Sunday 18:45 UTC.
    expect(iso(cadence, "2026-10-11T00:00:00.000Z", "2026-10-18T00:00:00.000Z")).toEqual([
      "2026-10-11T18:45:00.000Z",
      "2026-10-12T03:30:00.000Z",
      "2026-10-12T18:15:00.000Z",
    ]);
    expect(toLocalDateTime("2026-10-11T18:45:00.000Z", "Asia/Colombo")).toEqual({
      date: "2026-10-12",
      time: "00:15",
      weekday: "mon",
    });
  });

  it("handles a half-hour daylight saving change (Australia/Lord_Howe)", () => {
    // 2026-10-04: at 02:00 (+10:30) the clocks jump to 02:30 (+11:00), at 15:30 UTC.
    const cadence: SlotCadence = {
      days: ["sun"],
      slots: ["02:15", "03:00"],
      tz: "Australia/Lord_Howe",
    };

    expect(iso(cadence, "2026-10-03T00:00:00.000Z", "2026-10-05T00:00:00.000Z")).toEqual([
      "2026-10-03T15:30:00.000Z",
      "2026-10-03T16:00:00.000Z",
    ]);
  });

  it("follows the default format cadence in UTC", () => {
    expect(
      iso(DEFAULT_FORMAT_RULES.cadence, "2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z"),
    ).toEqual(["2026-10-12T09:00:00.000Z", "2026-10-14T09:00:00.000Z", "2026-10-16T09:00:00.000Z"]);
  });

  it("includes the start, excludes the end and accepts dates", () => {
    const cadence: SlotCadence = { days: ["mon"], slots: ["09:00"], tz: "UTC" };

    expect(iso(cadence, "2026-10-12T09:00:00.000Z", "2026-10-19T09:00:00.000Z")).toEqual([
      "2026-10-12T09:00:00.000Z",
    ]);
    expect(
      generateSlots(
        cadence,
        new Date("2026-10-12T09:00:01.000Z"),
        new Date("2026-10-19T09:00:01Z"),
      ),
    ).toEqual([new Date("2026-10-19T09:00:00.000Z")]);
  });

  it("gives no slots without days or times", () => {
    const range = ["2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z"] as const;

    expect(generateSlots({ days: [], slots: ["09:00"], tz: "UTC" }, ...range)).toEqual([]);
    expect(generateSlots({ days: ["mon"], slots: [], tz: "UTC" }, ...range)).toEqual([]);
  });
});

describe("slot range limits", () => {
  const cadence: SlotCadence = { days: ["mon", "thu"], slots: ["09:00"], tz: "Europe/London" };
  const from = "2026-10-01T00:00:00.000Z";
  const end = new Date(Date.parse(from) + MAX_CALENDAR_RANGE_MS).toISOString();
  const tooFar = new Date(Date.parse(from) + MAX_CALENDAR_RANGE_MS + 1).toISOString();

  it("covers up to 62 days", () => {
    expect(MAX_CALENDAR_RANGE_DAYS).toBe(62);
    expect(generateSlots(cadence, from, end)).toHaveLength(18);
    expect(() => generateSlots(cadence, from, tooFar)).toThrow(RangeError);
  });

  it("gives nothing for an empty or reversed range", () => {
    expect(generateSlots(cadence, from, from)).toEqual([]);
    expect(generateSlots(cadence, end, from)).toEqual([]);
  });

  it("refuses invalid times", () => {
    expect(() => generateSlots(cadence, "soon", end)).toThrow(RangeError);
    expect(() => generateSlots(cadence, from, new Date(Number.NaN))).toThrow(RangeError);
  });

  it("limits calendar queries and slot lookups to 62 days", () => {
    const getSlots = calendarTools["calendar.get_slots"].input;

    for (const schema of [CalendarQuerySchema, getSlots]) {
      expect(schema.safeParse({ from, to: end }).success).toBe(true);
      expect(schema.safeParse({ from, to: tooFar }).success).toBe(false);
      expect(schema.safeParse({ from, to: from }).success).toBe(false);
      expect(schema.safeParse({ from: end, to: from }).success).toBe(false);
    }
    const refused = CalendarQuerySchema.safeParse({ from, to: tooFar });
    expect(refused.error?.issues[0]?.path).toEqual(["to"]);
  });
});

describe("local date and time", () => {
  const tz = "America/New_York";

  it("resolves skipped and repeated local times like slots", () => {
    expect(fromLocalDateTime("2026-03-08", "02:30", tz).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(fromLocalDateTime("2026-11-01", "01:30", tz).toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(fromLocalDateTime("2026-10-13", "09:00", "Asia/Colombo").toISOString()).toBe(
      "2026-10-13T03:30:00.000Z",
    );
  });

  it("reads an instant back as local date, time and weekday", () => {
    expect(toLocalDateTime("2026-03-08T07:00:00.000Z", tz)).toEqual({
      date: "2026-03-08",
      time: "03:00",
      weekday: "sun",
    });
    expect(toLocalDateTime(new Date("2026-11-01T06:30:00.000Z"), tz).time).toBe("01:30");
  });

  it("refuses malformed dates and times", () => {
    expect(() => fromLocalDateTime("2026-02-30", "09:00", tz)).toThrow(RangeError);
    expect(() => fromLocalDateTime("2026-2-3", "09:00", tz)).toThrow(RangeError);
    expect(() => fromLocalDateTime("2026-02-03", "24:00", tz)).toThrow(RangeError);
  });
});

describe("publish mode policy", () => {
  const table: [PublishMode, boolean, PublishMode][] = [
    ["auto", false, "auto"],
    ["auto", true, "approval"],
    ["approval", false, "approval"],
    ["approval", true, "approval"],
  ];

  it.each(table)(
    "format %s with requiresApproval %s publishes in %s mode",
    (mode, required, expected) => {
      expect(effectivePublishMode(mode, required)).toBe(expected);
    },
  );

  it("covers every combination", () => {
    const combinations = PUBLISH_MODES.flatMap((mode) => [false, true].map((r) => `${mode}:${r}`));

    expect(table.map(([mode, required]) => `${mode}:${required}`).sort()).toEqual(
      combinations.sort(),
    );
  });
});
