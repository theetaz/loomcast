import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORMAT_RULES,
  type FormatRules,
  FormatRulesSchema,
  isTimeZone,
  TimeOfDaySchema,
} from "../src";

type Rules = Record<string, unknown>;

function rules(patch: Rules = {}): Rules {
  return { ...structuredClone(DEFAULT_FORMAT_RULES), ...patch };
}

function cadence(patch: Rules): Rules {
  return rules({ cadence: { ...DEFAULT_FORMAT_RULES.cadence, ...patch } });
}

function accepts(value: Rules): boolean {
  return FormatRulesSchema.safeParse(value).success;
}

function issuePaths(value: Rules): string[] {
  const result = FormatRulesSchema.safeParse(value);
  return result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
}

describe("default format rules", () => {
  it("are valid and frozen", () => {
    expect(FormatRulesSchema.parse(DEFAULT_FORMAT_RULES)).toEqual(DEFAULT_FORMAT_RULES);
    expect(Object.isFrozen(DEFAULT_FORMAT_RULES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_FORMAT_RULES.cadence.days)).toBe(true);
    expect(DEFAULT_FORMAT_RULES.publishMode).toBe("approval");
    expect(DEFAULT_FORMAT_RULES.voiceId).toBeUndefined();
  });

  it("accept every optional field", () => {
    const full: FormatRules = {
      ...structuredClone(DEFAULT_FORMAT_RULES),
      hookNotes: "Show the error first.",
      voiceId: "voice-1",
      voiceSpeed: 1.05,
      visualTemplate: {
        styleId: "kallaway",
        templateId: "kallaway.t1.hook.split",
        captions: { enabled: true, style: "line" },
      },
      topicPool: ["Ownership", "Lifetimes"],
      avoid: ["Unsafe code"],
      caption: { hashtags: ["rustlang"], cta: "Follow for more." },
      recipe: { name: "vertical-explainer", version: 2 },
    };

    expect(FormatRulesSchema.parse(full)).toEqual(full);
  });
});

describe("time zone", () => {
  it.each(["UTC", "Europe/London", "Asia/Colombo", "America/Argentina/Buenos_Aires", "Etc/GMT+5"])(
    "accepts %s",
    (tz) => {
      expect(isTimeZone(tz)).toBe(true);
      expect(accepts(cadence({ tz }))).toBe(true);
    },
  );

  it.each([
    "",
    "Mars/Phobos",
    "+05:30",
    "UTC+5",
    "Europe/../London",
    "Europe/London ",
    "Europe/London; DROP",
    `Europe/${"x".repeat(64)}`,
  ])("rejects %j", (tz) => {
    expect(isTimeZone(tz)).toBe(false);
    expect(issuePaths(cadence({ tz }))).toEqual(["cadence.tz"]);
  });
});

describe("cadence", () => {
  it("accepts 24-hour slots", () => {
    for (const slot of ["00:00", "09:30", "23:59"]) {
      expect(TimeOfDaySchema.safeParse(slot).success, slot).toBe(true);
    }
  });

  it("rejects malformed slots", () => {
    for (const slot of ["24:00", "9:00", "09:60", "09:5", "0930", "09:30:00", " 09:30", "noon"]) {
      expect(TimeOfDaySchema.safeParse(slot).success, slot).toBe(false);
      expect(accepts(cadence({ slots: [slot] })), slot).toBe(false);
    }
  });

  it("allows at most 12 distinct slots", () => {
    const slots = Array.from({ length: 13 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);

    expect(accepts(cadence({ slots: slots.slice(0, 12) }))).toBe(true);
    expect(accepts(cadence({ slots }))).toBe(false);
    expect(issuePaths(cadence({ slots: ["09:00", "09:00"] }))).toEqual(["cadence.slots"]);
  });

  it("allows each weekday once and no other days", () => {
    expect(accepts(cadence({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }))).toBe(
      true,
    );
    expect(accepts(cadence({ days: [], slots: [] }))).toBe(true);
    expect(accepts(cadence({ days: ["mon", "mon"] }))).toBe(false);
    expect(accepts(cadence({ days: ["monday"] }))).toBe(false);
  });

  it("bounds the lead time to 1 to 336 whole hours", () => {
    expect(accepts(cadence({ leadTimeHours: 1 }))).toBe(true);
    expect(accepts(cadence({ leadTimeHours: 336 }))).toBe(true);
    expect(accepts(cadence({ leadTimeHours: 0 }))).toBe(false);
    expect(accepts(cadence({ leadTimeHours: 337 }))).toBe(false);
    expect(accepts(cadence({ leadTimeHours: 1.5 }))).toBe(false);
  });
});

describe("length", () => {
  it("accepts 5 to 180 seconds with min at most max", () => {
    expect(accepts(rules({ lengthSec: { min: 5, max: 180 } }))).toBe(true);
    expect(accepts(rules({ lengthSec: { min: 45, max: 45 } }))).toBe(true);
  });

  it("rejects min above max on the max field", () => {
    expect(issuePaths(rules({ lengthSec: { min: 61, max: 60 } }))).toEqual(["lengthSec.max"]);
  });

  it("rejects lengths out of range or fractional", () => {
    expect(accepts(rules({ lengthSec: { min: 4, max: 60 } }))).toBe(false);
    expect(accepts(rules({ lengthSec: { min: 30, max: 181 } }))).toBe(false);
    expect(accepts(rules({ lengthSec: { min: 30.5, max: 60 } }))).toBe(false);
    expect(accepts(rules({ lengthSec: { min: 30 } }))).toBe(false);
  });
});

describe("voice, reading level and style", () => {
  it("bounds the reading grade to 3 to 16", () => {
    expect(accepts(rules({ readingLevel: { grade: 3 } }))).toBe(true);
    expect(accepts(rules({ readingLevel: { grade: 16 } }))).toBe(true);
    expect(accepts(rules({ readingLevel: { grade: 2 } }))).toBe(false);
    expect(accepts(rules({ readingLevel: { grade: 17 } }))).toBe(false);
  });

  it("bounds the voice speed to 0.7 to 1.3", () => {
    expect(accepts(rules({ voiceSpeed: 0.7 }))).toBe(true);
    expect(accepts(rules({ voiceSpeed: 1.3 }))).toBe(true);
    expect(accepts(rules({ voiceSpeed: 0.69 }))).toBe(false);
    expect(accepts(rules({ voiceSpeed: 1.31 }))).toBe(false);
    expect(accepts(rules({ voiceId: " " }))).toBe(false);
  });

  it("accepts only known hook and caption styles", () => {
    expect(accepts(rules({ hookStyle: "demo" }))).toBe(true);
    expect(accepts(rules({ hookStyle: "clickbait" }))).toBe(false);
    expect(
      accepts(
        rules({
          visualTemplate: {
            styleId: "vox-explainer",
            captions: { enabled: true, style: "karaoke" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("checks style ids for shape, not against the library", () => {
    const style = (styleId: string) =>
      accepts(rules({ visualTemplate: { ...DEFAULT_FORMAT_RULES.visualTemplate, styleId } }));

    expect(style("a-future-style")).toBe(true);
    expect(style("Vox Explainer")).toBe(false);
    expect(style("../styles")).toBe(false);
  });
});

describe("text lists and caption", () => {
  it("caps tone, topics and the avoid list", () => {
    expect(accepts(rules({ tone: "x".repeat(200) }))).toBe(true);
    expect(accepts(rules({ tone: "x".repeat(201) }))).toBe(false);
    expect(accepts(rules({ topicPool: Array.from({ length: 500 }, (_, i) => `t${i}`) }))).toBe(
      true,
    );
    expect(accepts(rules({ topicPool: Array.from({ length: 501 }, (_, i) => `t${i}`) }))).toBe(
      false,
    );
    expect(accepts(rules({ avoid: Array.from({ length: 200 }, (_, i) => `a${i}`) }))).toBe(true);
    expect(accepts(rules({ avoid: Array.from({ length: 201 }, (_, i) => `a${i}`) }))).toBe(false);
    expect(accepts(rules({ topicPool: [" "] }))).toBe(false);
  });

  it("stores hashtags without # and refuses repeats ignoring case", () => {
    const parsed = FormatRulesSchema.parse(
      rules({ caption: { hashtags: ["#RustLang", " dev "] } }),
    );

    expect(parsed.caption.hashtags).toEqual(["RustLang", "dev"]);
    expect(accepts(rules({ caption: { hashtags: ["rust", "#Rust"] } }))).toBe(false);
    expect(accepts(rules({ caption: { hashtags: ["two words"] } }))).toBe(false);
    expect(accepts(rules({ caption: { hashtags: ["#"] } }))).toBe(false);
    expect(accepts(rules({ caption: { hashtags: ["café_2026"] } }))).toBe(true);
  });

  it("allows at most 30 hashtags", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `tag${i}`);

    expect(accepts(rules({ caption: { hashtags: tags.slice(0, 30) } }))).toBe(true);
    expect(accepts(rules({ caption: { hashtags: tags } }))).toBe(false);
  });

  it("names a recipe by skill name", () => {
    expect(accepts(rules({ recipe: { name: "vertical-explainer" } }))).toBe(true);
    expect(accepts(rules({ recipe: { name: "Vertical Explainer" } }))).toBe(false);
    expect(accepts(rules({ recipe: { name: "vertical-explainer", version: 0 } }))).toBe(false);
  });

  it("needs a publish mode", () => {
    expect(accepts(rules({ publishMode: "auto" }))).toBe(true);
    expect(accepts(rules({ publishMode: "manual" }))).toBe(false);
    expect(accepts(rules({ publishMode: undefined }))).toBe(false);
  });
});
