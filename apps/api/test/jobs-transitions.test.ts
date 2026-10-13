import { JOB_STATUSES, type JobStatus } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import {
  isTerminalStatus,
  JOB_ACTIONS,
  type JobAction,
  nextStatus,
  statusesAllowing,
} from "../src/modules/jobs/transitions";

const ALLOWED: Record<JobAction, Partial<Record<JobStatus, JobStatus>>> = {
  dispatch: { queued: "dispatched" },
  accept: { dispatched: "running", running: "running" },
  complete: { dispatched: "succeeded", running: "succeeded" },
  fail: { dispatched: "failed", running: "failed" },
  requeue: { dispatched: "queued", running: "queued" },
  cancel: { queued: "cancelled", dispatched: "cancelled", running: "cancelled" },
};

describe("job status transitions", () => {
  it.each(JOB_ACTIONS.flatMap((action) => JOB_STATUSES.map((status) => [action, status] as const)))(
    "%s from %s",
    (action, status) => {
      expect(nextStatus(status, action)).toBe(ALLOWED[action][status] ?? null);
    },
  );

  it("never leaves a terminal status", () => {
    for (const status of JOB_STATUSES.filter(isTerminalStatus)) {
      for (const action of JOB_ACTIONS) {
        expect(nextStatus(status, action)).toBeNull();
      }
    }
    expect(JOB_STATUSES.filter(isTerminalStatus)).toEqual(["succeeded", "failed", "cancelled"]);
  });

  it("derives the SQL guard of each action from the transition function", () => {
    expect(statusesAllowing("dispatch")).toEqual(["queued"]);
    expect(statusesAllowing("accept")).toEqual(["dispatched", "running"]);
    expect(statusesAllowing("cancel")).toEqual(["queued", "dispatched", "running"]);
  });
});
