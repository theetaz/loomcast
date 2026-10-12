import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  IdSchema,
  JobErrorSchema,
  JobTypeSchema,
  JsonObjectSchema,
  TimestampSchema,
} from "@loomcast/contracts";
import { z } from "zod";
import type { Logger } from "./logger";
import {
  appendPrivateFileSync,
  ensurePrivateDir,
  isNotFound,
  writePrivateFileAtomic,
} from "./private-fs";

// The journal records how every finished job ended. When the server assigns a job the agent has
// already finished (for example because `job.complete` was lost in a disconnect), the agent
// answers from the journal instead of running the job a second time.

export const JobOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), result: JsonObjectSchema }),
  z.object({ status: z.literal("failed"), error: JobErrorSchema }),
]);
export type JobOutcome = z.infer<typeof JobOutcomeSchema>;

export const JournalEntrySchema = z.object({
  jobId: IdSchema,
  type: JobTypeSchema,
  attempt: z.number().int().min(1),
  finishedAt: TimestampSchema,
  /** The last durable event sequence number, so a retry continues after it. */
  lastSeq: z.number().int().min(0),
  outcome: JobOutcomeSchema,
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/** Job leases last minutes, so a week of history covers every possible re-assignment. */
export const DEFAULT_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface JournalOptions {
  readonly log: Logger;
  readonly retentionMs?: number;
  readonly now?: () => Date;
}

export class Journal {
  readonly #file: string;
  readonly #entries = new Map<string, JournalEntry>();

  private constructor(file: string) {
    this.#file = file;
  }

  /**
   * Loads `journal.jsonl`. The latest line per job wins; entries older than the retention period
   * and unreadable lines are dropped, and the file is compacted when anything was dropped.
   */
  static open(file: string, options: JournalOptions): Journal {
    const journal = new Journal(file);
    ensurePrivateDir(dirname(file));
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
    const cutoff =
      (options.now ?? (() => new Date()))().getTime() -
      (options.retentionMs ?? DEFAULT_JOURNAL_RETENTION_MS);
    let lines = 0;
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      lines += 1;
      const entry = parseEntry(line);
      if (entry === null) {
        skipped += 1;
      } else {
        journal.#entries.set(entry.jobId, entry);
      }
    }
    for (const [jobId, entry] of journal.#entries) {
      if (Date.parse(entry.finishedAt) < cutoff) {
        journal.#entries.delete(jobId);
      }
    }
    if (skipped > 0) {
      options.log.warn("skipped unreadable journal lines", { skipped });
    }
    if (journal.#entries.size !== lines) {
      journal.#compact();
    }
    return journal;
  }

  get(jobId: string): JournalEntry | undefined {
    return this.#entries.get(jobId);
  }

  /** Appends an entry and flushes it to disk before returning. */
  record(entry: JournalEntry): void {
    const valid = JournalEntrySchema.parse(entry);
    appendPrivateFileSync(this.#file, `${JSON.stringify(valid)}\n`);
    this.#entries.set(valid.jobId, valid);
  }

  #compact(): void {
    const text = [...this.#entries.values()].map((entry) => `${JSON.stringify(entry)}\n`).join("");
    writePrivateFileAtomic(this.#file, text);
  }
}

function parseEntry(line: string): JournalEntry | null {
  try {
    const result = JournalEntrySchema.safeParse(JSON.parse(line));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
