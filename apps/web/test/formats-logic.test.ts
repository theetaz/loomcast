import {
  DEFAULT_FORMAT_RULES,
  type FormatRules,
  type FormatRulesInput,
  FormatRulesSchema,
} from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import { nextSlotTime } from "@/features/formats/CadenceFields";
import { mergeEntries, splitLines } from "@/features/formats/ChipsInput";
import {
  cadenceSummary,
  searchTimeZones,
  sortDays,
  toggleDay,
  upcomingSlots,
} from "@/features/formats/cadence";
import { cleanHashtag } from "@/features/formats/FormatEditor";
import { diffJson } from "@/features/formats/json-diff";
import {
  type FormatFormValues,
  fieldError,
  formatFormResolver,
  formPathOf,
  invalidEntries,
  normalizeRules,
  serverFieldErrors,
} from "@/features/formats/rules-form";
import { ApiError } from "@/lib/api";

function rules(change: (draft: FormatRulesInput) => void = () => {}): FormatRulesInput {
  const draft = structuredClone(DEFAULT_FORMAT_RULES) as FormatRulesInput;
  change(draft);
  return draft;
}

async function resolve(values: FormatFormValues) {
  return formatFormResolver(values, undefined, {
    fields: {},
    shouldUseNativeValidation: false,
  });
}

describe("format rules validation", () => {
  it("accepts the default rules and submits them unchanged", async () => {
    const result = await resolve({ name: "Ownership basics", rules: rules() });
    expect(result.errors).toEqual({});
    expect(result.values).toEqual({ name: "Ownership basics", rules: DEFAULT_FORMAT_RULES });
  });

  it("reports a reversed length range on the longest length, as the contracts do", async () => {
    const result = await resolve({
      name: "Shorts",
      rules: rules((draft) => {
        draft.lengthSec = { min: 70, max: 40 };
      }),
    });
    expect(fieldError(result.errors, "rules.lengthSec.max")).toBe(
      "The shortest length must not exceed the longest",
    );
    expect(fieldError(result.errors, "rules.lengthSec.min")).toBeUndefined();
  });

  it("maps every refused field onto its own path", async () => {
    const result = await resolve({
      name: "  ",
      rules: rules((draft) => {
        draft.readingLevel.grade = Number.NaN;
        draft.voiceSpeed = 2;
        draft.cadence.tz = "+05:30";
        draft.cadence.days = ["mon", "mon"];
        draft.cadence.slots = ["9:00"];
        draft.cadence.leadTimeHours = 0;
        draft.visualTemplate.styleId = "Vox Explainer";
        draft.caption.hashtags = ["rust", "no spaces"];
      }),
    });
    const errors = result.errors;
    expect(fieldError(errors, "name")).toBe("Required");
    expect(fieldError(errors, "rules.readingLevel.grade")).toBe("Enter a number");
    expect(fieldError(errors, "rules.voiceSpeed")).toBe("Use 1.3 or less");
    expect(fieldError(errors, "rules.cadence.tz")).toBe(
      "Use an IANA time zone such as Europe/London",
    );
    expect(fieldError(errors, "rules.cadence.days")).toBe("Days must not repeat");
    expect(fieldError(errors, "rules.cadence.slots")).toBe("Use a 24-hour time such as 09:30");
    expect(fieldError(errors, "rules.cadence.leadTimeHours")).toBe("Use 1 or more");
    expect(fieldError(errors, "rules.visualTemplate.styleId")).toBe(
      "Use a style id such as vox-explainer",
    );
    expect(fieldError(errors, "rules.caption.hashtags")).toBe(
      "Use letters, digits and underscores only",
    );
    expect([...invalidEntries(errors, "rules.caption.hashtags")]).toEqual([1]);
  });

  it("refuses hashtags that repeat ignoring case", async () => {
    const result = await resolve({
      name: "Shorts",
      rules: rules((draft) => {
        draft.caption.hashtags = ["RustLang", "rustlang"];
      }),
    });
    expect(fieldError(result.errors, "rules.caption.hashtags")).toBe("Hashtags must not repeat");
  });

  it("leaves empty optional fields out instead of sending empty strings", async () => {
    const values: FormatFormValues = {
      name: "Shorts",
      rules: rules((draft) => {
        draft.voiceId = "  ";
        draft.voiceSpeed = Number.NaN;
        draft.hookNotes = "";
        draft.caption.cta = "";
        draft.visualTemplate.templateId = "";
        draft.recipe = { name: "" };
      }),
    };
    const result = await resolve(values);
    expect(result.errors).toEqual({});
    expect(result.values?.rules).toEqual(DEFAULT_FORMAT_RULES);
    expect(Object.keys(result.values?.rules ?? {})).not.toContain("voiceId");
  });

  it("strips the # from hashtags the way the contracts store them", async () => {
    expect(cleanHashtag("  #RustLang ")).toBe("RustLang");
    const result = await resolve({
      name: "Shorts",
      rules: rules((draft) => {
        draft.caption.hashtags = ["#rustlang"];
      }),
    });
    expect(result.values?.rules.caption.hashtags).toEqual(["rustlang"]);
  });

  it("accepts and refuses exactly what FormatRulesSchema does", async () => {
    const candidates: FormatRulesInput[] = [
      rules(),
      rules((draft) => {
        draft.lengthSec = { min: 5, max: 180 };
      }),
      rules((draft) => {
        draft.lengthSec = { min: 4, max: 60 };
      }),
      rules((draft) => {
        draft.readingLevel.grade = 16;
      }),
      rules((draft) => {
        draft.readingLevel.grade = 17;
      }),
      rules((draft) => {
        draft.voiceSpeed = 0.7;
      }),
      rules((draft) => {
        draft.voiceSpeed = 0.69;
      }),
      rules((draft) => {
        draft.cadence.slots = Array.from(
          { length: 13 },
          (_, hour) => `${String(hour).padStart(2, "0")}:00`,
        );
      }),
      rules((draft) => {
        draft.cadence.slots = [];
        draft.cadence.days = [];
      }),
      rules((draft) => {
        draft.cadence.tz = "America/Argentina/Buenos_Aires";
      }),
      rules((draft) => {
        draft.cadence.tz = "Mars/Olympus";
      }),
      rules((draft) => {
        draft.cadence.leadTimeHours = 336;
      }),
      rules((draft) => {
        draft.cadence.leadTimeHours = 337;
      }),
      rules((draft) => {
        draft.caption.hashtags = Array.from({ length: 31 }, (_, index) => `tag${index}`);
      }),
      rules((draft) => {
        draft.topicPool = ["x".repeat(201)];
      }),
      rules((draft) => {
        draft.visualTemplate.templateId = "vox-explainer.t1.section.circle";
      }),
      rules((draft) => {
        draft.visualTemplate.templateId = "Not A Card";
      }),
      rules((draft) => {
        draft.recipe = { name: "vertical-explainer", version: 0 };
      }),
    ];
    for (const candidate of candidates) {
      const result = await resolve({ name: "Shorts", rules: candidate });
      const contract = FormatRulesSchema.safeParse(normalizeRules(candidate));
      expect(Object.keys(result.errors).length === 0).toBe(contract.success);
    }
  });
});

describe("server validation errors", () => {
  it("maps API issue paths onto form fields, lists onto the list", () => {
    const error = new ApiError(400, "validation_failed", "The request is not valid.", [
      { path: "rules.lengthSec.max", message: "Too long" },
      { path: "rules.caption.hashtags.3", message: "Bad hashtag" },
      { path: "baseVersionId", message: "Invalid id" },
      { path: "name", message: "Too long" },
    ]);
    expect(serverFieldErrors(error)).toEqual([
      { name: "rules.lengthSec.max", message: "Too long" },
      { name: "rules.caption.hashtags", message: "Bad hashtag" },
      { name: "name", message: "Too long" },
    ]);
    expect(formPathOf("rules.topicPool.0")).toBe("rules.topicPool");
    expect(serverFieldErrors(new ApiError(409, "conflict", "Stale"))).toEqual([]);
  });
});

describe("cadence helpers", () => {
  it("toggles days in week order", () => {
    expect(toggleDay(["fri", "mon"], "wed")).toEqual(["mon", "wed", "fri"]);
    expect(toggleDay(["mon", "wed"], "mon")).toEqual(["wed"]);
    expect(sortDays(["sun", "nope", "tue"])).toEqual(["tue", "sun"]);
  });

  it("summarises a cadence in one line", () => {
    expect(
      cadenceSummary({ days: ["fri", "mon", "wed"], slots: ["18:00", "09:00"], tz: "UTC" }),
    ).toBe("Mon, Wed, Fri at 09:00, 18:00 · UTC");
    expect(
      cadenceSummary({
        days: ["mon", "tue", "wed", "thu", "fri"],
        slots: ["08:00"],
        tz: "Europe/London",
      }),
    ).toBe("Weekdays at 08:00 · Europe/London");
    expect(cadenceSummary({ days: [], slots: ["08:00"], tz: "UTC" })).toBe("No publishing slots");
  });

  it("previews slots in the series time zone across a daylight saving change", () => {
    // London leaves summer time on 2026-10-25: 09:00 local is 08:00 UTC before, 09:00 UTC after.
    const slots = upcomingSlots(
      { days: ["sat", "mon"], slots: ["09:00"], tz: "Europe/London" },
      2,
      Date.parse("2026-10-23T12:00:00.000Z"),
    );
    expect(slots.map((slot) => slot.toISOString())).toEqual([
      "2026-10-24T08:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
    ]);
    expect(upcomingSlots({ days: ["mon"], slots: ["09:00"], tz: "+05:30" }, 3)).toEqual([]);
  });

  it("finds time zones by city, ignoring case and underscores", () => {
    const zones = ["UTC", "America/New_York", "Europe/London", "America/Argentina/Buenos_Aires"];
    expect(searchTimeZones("new york", zones)).toEqual(["America/New_York"]);
    expect(searchTimeZones("LON", zones)).toEqual(["Europe/London"]);
    expect(searchTimeZones("america", zones)).toEqual([
      "America/New_York",
      "America/Argentina/Buenos_Aires",
    ]);
    expect(searchTimeZones("", zones)).toEqual(zones);
  });

  it("suggests the next free time an hour after the last", () => {
    expect(nextSlotTime([])).toBe("09:00");
    expect(nextSlotTime(["09:30", "18:00"])).toBe("19:00");
    expect(nextSlotTime(["23:00"])).toBe("");
  });
});

describe("chips", () => {
  it("splits pasted lists into entries, one per line", () => {
    expect(splitLines(" borrowing \r\n\nmoves\nlifetimes  \n")).toEqual([
      "borrowing",
      "moves",
      "lifetimes",
    ]);
  });

  it("merges entries without repeats", () => {
    expect(mergeEntries(["Rust"], ["rust", "Go", "Go"])).toEqual(["Rust", "rust", "Go"]);
    expect(mergeEntries(["Rust"], ["rust", "Go"], true)).toEqual(["Rust", "Go"]);
  });
});

describe("rules diff", () => {
  it("lists changed values, added keys and list entries by path", () => {
    const before = DEFAULT_FORMAT_RULES;
    const after: FormatRules = {
      ...structuredClone(DEFAULT_FORMAT_RULES),
      voiceId: "ava",
      lengthSec: { min: 30, max: 45 },
      topicPool: ["moves"],
      cadence: { ...DEFAULT_FORMAT_RULES.cadence, days: ["mon", "fri"], tz: "Europe/London" },
    };
    expect(diffJson(before, after)).toEqual([
      { kind: "changed", path: "lengthSec.max", before: 60, after: 45 },
      { kind: "list", path: "topicPool", added: ["moves"], removed: [] },
      { kind: "list", path: "cadence.days", added: [], removed: ["wed"] },
      { kind: "changed", path: "cadence.tz", before: "UTC", after: "Europe/London" },
      { kind: "added", path: "voiceId", after: "ava" },
    ]);
    expect(diffJson(before, structuredClone(before))).toEqual([]);
  });
});
