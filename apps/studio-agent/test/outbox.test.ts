import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/logger";
import { Outbox } from "../src/outbox";
import { ids, tempAgentPaths } from "./helpers";

const job = { type: "producer.chat", attempt: 1 } as const;

function openOutbox(dir = tempAgentPaths().outboxDir): { outbox: Outbox; dir: string } {
  return { outbox: Outbox.open(dir, silentLogger), dir };
}

function fileLines(dir: string, jobId: string): unknown[] {
  return readFileSync(join(dir, `${jobId}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("outbox", () => {
  it("assigns monotonic sequence numbers per job and writes private files", () => {
    const { outbox, dir } = openOutbox();
    outbox.open(ids.job, job);
    outbox.open(ids.otherJob, job);
    const first = outbox.append(ids.job, "status", { state: "starting" });
    const second = outbox.append(ids.job, "log", { level: "info", message: "hello" });
    const other = outbox.append(ids.otherJob, "status", { state: "starting" });

    expect([first.seq, second.seq, other.seq]).toEqual([1, 2, 1]);
    expect(outbox.pending(ids.job)).toEqual([first, second]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, `${ids.job}.jsonl`)).mode & 0o777).toBe(0o600);
  });

  it("rejects event data that does not match the contracts", () => {
    const { outbox } = openOutbox();
    outbox.open(ids.job, job);
    expect(() => outbox.append(ids.job, "status", { state: "" } as { state: string })).toThrow();
    expect(outbox.lastSeq(ids.job)).toBe(0);
  });

  it("trims acked events from memory and disk on a cumulative ack", () => {
    const { outbox, dir } = openOutbox();
    outbox.open(ids.job, job);
    for (const state of ["a", "b", "c"]) {
      outbox.append(ids.job, "status", { state });
    }
    outbox.ack(ids.job, 2);

    expect(outbox.pending(ids.job).map((event) => event.seq)).toEqual([3]);
    expect(outbox.lastAckedSeq(ids.job)).toBe(2);
    expect(fileLines(dir, ids.job)).toEqual([
      { t: "header", type: "producer.chat", attempt: 1, ackedSeq: 2 },
      { t: "event", event: expect.objectContaining({ seq: 3 }) },
    ]);

    // Older and duplicate acks change nothing; an ack past the end is clamped.
    outbox.ack(ids.job, 1);
    expect(outbox.lastAckedSeq(ids.job)).toBe(2);
    outbox.ack(ids.job, 99);
    expect(outbox.lastAckedSeq(ids.job)).toBe(3);
    expect(outbox.pending(ids.job)).toEqual([]);
    // Numbering continues after the acked events.
    expect(outbox.append(ids.job, "status", { state: "d" }).seq).toBe(4);
  });

  it("restores pending events and numbering after a restart", () => {
    const { outbox, dir } = openOutbox();
    outbox.open(ids.job, job);
    outbox.append(ids.job, "status", { state: "a" });
    outbox.append(ids.job, "status", { state: "b" });
    outbox.ack(ids.job, 1);

    const reopened = Outbox.open(dir, silentLogger);
    expect(reopened.job(ids.job)).toEqual(job);
    expect(reopened.pending(ids.job).map((event) => event.seq)).toEqual([2]);
    expect(reopened.resumeEntries()).toEqual([{ jobId: ids.job, lastAckedSeq: 1 }]);
    expect(reopened.append(ids.job, "status", { state: "c" }).seq).toBe(3);
  });

  it("skips a line torn by a crash", () => {
    const { outbox, dir } = openOutbox();
    outbox.open(ids.job, job);
    outbox.append(ids.job, "status", { state: "a" });
    appendFileSync(join(dir, `${ids.job}.jsonl`), '{"t":"event","event":{"jobId"');

    const reopened = Outbox.open(dir, silentLogger);
    expect(reopened.pending(ids.job).map((event) => event.seq)).toEqual([1]);
    expect(reopened.append(ids.job, "status", { state: "b" }).seq).toBe(2);
  });

  it("continues numbering after startSeq for a retried job", () => {
    const { outbox } = openOutbox();
    outbox.open(ids.job, { type: "system.ping", attempt: 2 }, 5);
    expect(outbox.append(ids.job, "status", { state: "running" }).seq).toBe(6);
    expect(outbox.resumeEntries()).toEqual([{ jobId: ids.job, lastAckedSeq: 5 }]);
  });

  it("removes a settled job's file", () => {
    const { outbox, dir } = openOutbox();
    outbox.open(ids.job, job);
    outbox.remove(ids.job);
    expect(outbox.has(ids.job)).toBe(false);
    expect(existsSync(join(dir, `${ids.job}.jsonl`))).toBe(false);
    expect(Outbox.open(dir, silentLogger).jobIds()).toEqual([]);
  });
});
