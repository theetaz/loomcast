import { appendFileSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Journal, type JournalEntry } from "../src/journal";
import { silentLogger } from "../src/logger";
import { ids, tempAgentPaths } from "./helpers";

const finishedAt = "2026-10-12T10:00:00.000Z";
const now = () => new Date("2026-10-12T12:00:00.000Z");

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    jobId: ids.job,
    type: "system.ping",
    attempt: 1,
    finishedAt,
    lastSeq: 1,
    outcome: { status: "succeeded", result: { ok: true } },
    ...overrides,
  };
}

describe("journal", () => {
  it("records outcomes durably and reloads them", () => {
    const { journalFile } = tempAgentPaths();
    const journal = Journal.open(journalFile, { log: silentLogger, now });
    journal.record(entry());
    expect(journal.get(ids.job)).toEqual(entry());
    expect(statSync(journalFile).mode & 0o777).toBe(0o600);

    expect(Journal.open(journalFile, { log: silentLogger, now }).get(ids.job)).toEqual(entry());
  });

  it("keeps the latest entry per job and compacts the file", () => {
    const { journalFile } = tempAgentPaths();
    const journal = Journal.open(journalFile, { log: silentLogger, now });
    const failed = entry({
      outcome: {
        status: "failed",
        error: { code: "interrupted", message: "stopped", retryable: true },
      },
    });
    journal.record(failed);
    journal.record(entry({ attempt: 2 }));
    appendFileSync(journalFile, "{torn");

    const reopened = Journal.open(journalFile, { log: silentLogger, now });
    expect(reopened.get(ids.job)?.attempt).toBe(2);
    expect(readFileSync(journalFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("drops entries older than the retention period", () => {
    const { journalFile } = tempAgentPaths();
    Journal.open(journalFile, { log: silentLogger, now }).record(entry());
    const later = () => new Date("2026-10-20T10:00:00.000Z");
    expect(
      Journal.open(journalFile, { log: silentLogger, now: later }).get(ids.job),
    ).toBeUndefined();
    expect(readFileSync(journalFile, "utf8")).toBe("");
  });
});
