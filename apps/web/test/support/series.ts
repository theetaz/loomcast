import { mockFormat, mockRules } from "@/mocks/formats";
import { at, librarySetup } from "./library";

/**
 * The library setup with formats for its series: "Ownership basics" has two versions (the
 * second sets a voice, a London cadence and hashtags), "Error handling" one and "Agent patterns"
 * one with an empty cadence.
 */
export function seriesSetup() {
  const setup = librarySetup();
  const { db, rust, agents, series } = setup;

  const ownership = mockFormat(
    { id: series.ownership.formatId, projectId: rust.id, name: "Ownership basics" },
    [
      mockRules(),
      mockRules((rules) => {
        rules.lengthSec = { min: 30, max: 50 };
        rules.voiceId = "voice-ava";
        rules.topicPool = ["borrowing", "moves"];
        rules.cadence = {
          days: ["mon", "wed", "fri"],
          slots: ["09:00", "18:00"],
          tz: "Europe/London",
          leadTimeHours: 36,
        };
        rules.caption = { hashtags: ["rustlang"] };
      }),
    ],
    at(0),
  );
  const errors = mockFormat(
    { id: series.errors.formatId, projectId: rust.id, name: "Error handling" },
    [
      mockRules((rules) => {
        rules.cadence = { days: ["tue", "thu"], slots: ["12:30"], tz: "UTC", leadTimeHours: 24 };
        rules.publishMode = "auto";
      }),
    ],
    at(0),
  );
  const patterns = mockFormat(
    { id: series.patterns.formatId, projectId: agents.id, name: "Agent patterns" },
    [
      mockRules((rules) => {
        rules.cadence = { ...rules.cadence, days: [], slots: [] };
      }),
    ],
    at(0),
  );
  for (const created of [ownership, errors, patterns]) {
    db.formats.push(created.format);
    db.formatVersions.push(...created.versions);
  }
  return {
    ...setup,
    formats: { ownership: ownership.format, errors: errors.format, patterns: patterns.format },
  };
}
