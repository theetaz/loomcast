import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  BRIDGE_LIMITS,
  IdSchema,
  type JobEvent,
  type JobEventData,
  type JobEventKind,
  JobEventSchema,
  type JobType,
  JobTypeSchema,
  type ResumeEntry,
} from "@loomcast/contracts";
import { z } from "zod";
import type { Logger } from "./logger";
import { appendPrivateFileSync, ensurePrivateDir, writePrivateFileAtomic } from "./private-fs";

// One JSONL file per unsettled job. The first line is a header with the job type, the attempt and
// the highest sequence number the server has acked; every further line is one durable event. An
// ack rewrites the file without the acked events, so the file only ever holds what may still need
// to be replayed.

const HeaderLineSchema = z.object({
  t: z.literal("header"),
  type: JobTypeSchema,
  attempt: z.number().int().min(1),
  ackedSeq: z.number().int().min(0),
});

const EventLineSchema = z.object({
  t: z.literal("event"),
  event: JobEventSchema,
});

const LineSchema = z.discriminatedUnion("t", [HeaderLineSchema, EventLineSchema]);

export interface OutboxJob {
  readonly type: JobType;
  readonly attempt: number;
}

interface JobState extends OutboxJob {
  ackedSeq: number;
  lastSeq: number;
  events: JobEvent[];
}

const FILE_SUFFIX = ".jsonl";

/** The durable event outbox of the studio agent. */
export class Outbox {
  readonly #dir: string;
  readonly #log: Logger;
  readonly #jobs = new Map<string, JobState>();

  private constructor(dir: string, log: Logger) {
    this.#dir = dir;
    this.#log = log;
  }

  /** Opens the outbox in `dir` (created if missing) and loads every job file in it. */
  static open(dir: string, log: Logger): Outbox {
    ensurePrivateDir(dir);
    const outbox = new Outbox(dir, log);
    for (const name of readdirSync(dir)) {
      const jobId = name.endsWith(FILE_SUFFIX) ? name.slice(0, -FILE_SUFFIX.length) : null;
      if (jobId !== null && IdSchema.safeParse(jobId).success) {
        outbox.#load(jobId);
      }
    }
    return outbox;
  }

  /** Jobs that still have an outbox file. */
  jobIds(): string[] {
    return [...this.#jobs.keys()];
  }

  has(jobId: string): boolean {
    return this.#jobs.has(jobId);
  }

  job(jobId: string): OutboxJob | undefined {
    const state = this.#jobs.get(jobId);
    return state && { type: state.type, attempt: state.attempt };
  }

  /**
   * Starts (or restarts) the outbox of a job. Sequence numbers continue after `startSeq` and after
   * any event already in the file, so a retried job never reuses a sequence number.
   */
  open(jobId: string, job: OutboxJob, startSeq = 0): void {
    const existing = this.#jobs.get(jobId);
    const state: JobState = existing
      ? { ...existing, ...job, lastSeq: Math.max(existing.lastSeq, startSeq) }
      : { ...job, ackedSeq: startSeq, lastSeq: startSeq, events: [] };
    this.#jobs.set(jobId, state);
    this.#rewrite(jobId, state);
  }

  /** Assigns the next sequence number to an event, writes it to disk and returns it. */
  append<K extends JobEventKind>(jobId: string, kind: K, data: JobEventData<K>): JobEvent {
    const state = this.#require(jobId);
    const event = JobEventSchema.parse({ jobId, seq: state.lastSeq + 1, kind, data });
    appendPrivateFileSync(this.#file(jobId), `${JSON.stringify({ t: "event", event })}\n`);
    state.lastSeq = event.seq;
    state.events.push(event);
    return event;
  }

  /** Applies a cumulative ack: every event up to `upToSeq` is stored by the server. */
  ack(jobId: string, upToSeq: number): void {
    const state = this.#jobs.get(jobId);
    if (state === undefined) {
      return;
    }
    const ackedSeq = Math.min(upToSeq, state.lastSeq);
    if (ackedSeq <= state.ackedSeq) {
      return;
    }
    state.ackedSeq = ackedSeq;
    state.events = state.events.filter((event) => event.seq > ackedSeq);
    this.#rewrite(jobId, state);
  }

  /** Events not acked yet, in sequence order, for replay after a reconnect. */
  pending(jobId: string): readonly JobEvent[] {
    return this.#jobs.get(jobId)?.events ?? [];
  }

  lastAckedSeq(jobId: string): number {
    return this.#jobs.get(jobId)?.ackedSeq ?? 0;
  }

  /** The highest sequence number used so far, or 0. */
  lastSeq(jobId: string): number {
    return this.#jobs.get(jobId)?.lastSeq ?? 0;
  }

  /** The `hello.resume` list: every unsettled job and its last acked event. */
  resumeEntries(): ResumeEntry[] {
    return [...this.#jobs.entries()]
      .slice(0, BRIDGE_LIMITS.maxJobsPerMessage)
      .map(([jobId, state]) => ({ jobId, lastAckedSeq: state.ackedSeq }));
  }

  /** Deletes a settled job's file. */
  remove(jobId: string): void {
    this.#jobs.delete(jobId);
    rmSync(this.#file(jobId), { force: true });
  }

  #require(jobId: string): JobState {
    const state = this.#jobs.get(jobId);
    if (state === undefined) {
      throw new Error(`Job ${jobId} has no outbox`);
    }
    return state;
  }

  #file(jobId: string): string {
    return join(this.#dir, `${IdSchema.parse(jobId)}${FILE_SUFFIX}`);
  }

  #rewrite(jobId: string, state: JobState): void {
    const header = {
      t: "header",
      type: state.type,
      attempt: state.attempt,
      ackedSeq: state.ackedSeq,
    };
    const lines = [header, ...state.events.map((event) => ({ t: "event", event }))];
    writePrivateFileAtomic(
      this.#file(jobId),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
  }

  /** Reads a job file. Lines that do not parse, such as one torn by a crash, are skipped. */
  #load(jobId: string): void {
    let header: z.infer<typeof HeaderLineSchema> | null = null;
    const events = new Map<number, JobEvent>();
    let skipped = 0;
    for (const text of readFileSync(this.#file(jobId), "utf8").split("\n")) {
      if (text.trim() === "") {
        continue;
      }
      const line = parseLine(text);
      if (line === null || (line.t === "event" && line.event.jobId !== jobId)) {
        skipped += 1;
      } else if (line.t === "header") {
        header = line;
      } else {
        events.set(line.event.seq, line.event);
      }
    }
    if (skipped > 0) {
      this.#log.warn("skipped unreadable outbox lines", { jobId, skipped });
    }
    if (header === null) {
      this.#log.warn("discarding an outbox file without a header", { jobId });
      rmSync(this.#file(jobId), { force: true });
      return;
    }
    const ackedSeq = header.ackedSeq;
    const pending = [...events.values()]
      .filter((event) => event.seq > ackedSeq)
      .sort((a, b) => a.seq - b.seq);
    this.#jobs.set(jobId, {
      type: header.type,
      attempt: header.attempt,
      ackedSeq,
      lastSeq: Math.max(ackedSeq, ...pending.map((event) => event.seq)),
      events: pending,
    });
  }
}

function parseLine(text: string): z.infer<typeof LineSchema> | null {
  try {
    const result = LineSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
