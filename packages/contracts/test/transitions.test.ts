import { describe, expect, it } from "vitest";
import {
  ACTOR_KINDS,
  type ActorKind,
  allowedActions,
  canTransition,
  findTransition,
  ITEM_ACTIONS,
  type ItemAction,
  nextProductionStep,
  PIPELINE_STATES,
  PIPELINE_TRANSITIONS,
  type PipelineState,
  REVIEW_DECISION_STATES,
  stageForArtifacts,
  TRANSITION_VIA,
  type VersionArtifacts,
} from "../src";

const rendered: VersionArtifacts = {
  script: {},
  storyboard: {},
  voiceAssetId: "voice",
  renderAssetId: "render",
};
const voiced: VersionArtifacts = { ...rendered, renderAssetId: null };
const scripted: VersionArtifacts = { script: {} };
const bare: VersionArtifacts = {};

const PRODUCTION: readonly PipelineState[] = ["idea", "script", "storyboard", "voice", "render"];
const VERSION_STAGES: readonly PipelineState[] = ["script", "storyboard", "voice", "render"];

/**
 * The pipeline rules restated independently of the table, as the plan describes them. The
 * exhaustive test below compares every `from × to × actor` combination against this.
 */
function expected(
  from: PipelineState,
  to: PipelineState,
  actor: ActorKind,
  hasRender: boolean,
): boolean {
  const user = actor === "user";
  const userOrSystem = user || actor === "system";
  // Archiving is a user's call from anywhere, and the system's for ideas only; restoring returns
  // an archived item as an idea.
  if (to === "archived") return from !== "archived" && (user || (from === "idea" && userOrSystem));
  if (from === "archived") return user && to === "idea";
  // Anyone may add a version while the item is in production or in review.
  if ((PRODUCTION.includes(from) || from === "review") && VERSION_STAGES.includes(to)) return true;
  // A user may change only the caption or notes of a rendered item in review.
  if (from === "review" && to === "review") return user && hasRender;
  // Anyone may send a rendered version to review.
  if (PRODUCTION.includes(from) && to === "review") return hasRender;
  // Users approve; the system approves under the auto publish mode (M4). Only a rendered version.
  if (from === "review" && to === "approved") return userOrSystem && hasRender;
  // An edit after approval goes back into production, or keeps the approval for caption and notes.
  if (from === "approved" && ["script", "storyboard", "voice"].includes(to)) return user;
  if (from === "approved" && to === "approved") return user && hasRender;
  // A composed post whose media change goes back to render, ready to submit again.
  if (from === "approved" && to === "render") return user && hasRender;
  // Calendar and publisher (M4).
  if (from === "approved" && to === "scheduled") return userOrSystem && hasRender;
  if (from === "scheduled" && to === "approved") return userOrSystem && hasRender;
  if (from === "scheduled" && to === "published") return actor === "system" && hasRender;
  return false;
}

describe("transition table", () => {
  describe.each(ACTOR_KINDS)("as %s", (actor) => {
    it.each(PIPELINE_STATES)("from %s matches the rules for every target", (from) => {
      for (const to of PIPELINE_STATES) {
        expect(canTransition(from, to, actor, rendered), `${from} -> ${to} rendered`).toBe(
          expected(from, to, actor, true),
        );
        expect(canTransition(from, to, actor, voiced), `${from} -> ${to} not rendered`).toBe(
          expected(from, to, actor, false),
        );
        expect(canTransition(from, to, actor), `${from} -> ${to} without a version`).toBe(
          expected(from, to, actor, false),
        );
      }
    });
  });

  it("uses known states, actors and kinds of move, without repeated rows", () => {
    const keys = PIPELINE_TRANSITIONS.map((row) => `${row.from}>${row.to}>${row.via}`);

    expect(new Set(keys).size).toBe(keys.length);
    for (const row of PIPELINE_TRANSITIONS) {
      expect(PIPELINE_STATES).toContain(row.from);
      expect(PIPELINE_STATES).toContain(row.to);
      expect(TRANSITION_VIA).toContain(row.via);
      expect(row.actors.length).toBeGreaterThan(0);
      for (const actor of row.actors) expect(ACTOR_KINDS).toContain(actor);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PIPELINE_TRANSITIONS)).toBe(true);
    expect(PIPELINE_TRANSITIONS.every((row) => Object.isFrozen(row))).toBe(true);
  });

  it("limits devices and tokens to adding versions and submitting to review", () => {
    const vias = new Set(
      PIPELINE_TRANSITIONS.filter(
        (row) => row.actors.includes("device") || row.actors.includes("token"),
      ).map((row) => row.via),
    );

    expect([...vias].sort()).toEqual(["submit", "version"]);
  });

  it("leaves review decisions, archiving and restoring to users", () => {
    for (const via of ["approve", "request_changes", "reject", "edit", "archive", "restore"]) {
      const rows = PIPELINE_TRANSITIONS.filter((row) => row.via === via);

      expect(rows.length, via).toBeGreaterThan(0);
      for (const row of rows) {
        // The cadence planner (system) may archive the ideas it retires, and nothing else.
        const actors = via === "archive" && row.from === "idea" ? ["user", "system"] : ["user"];
        expect(row.actors, `${via} from ${row.from}`).toEqual(actors);
      }
    }
    expect(
      findTransition({ from: "review", to: "approved", actor: "system", via: "approve" }),
    ).toBeUndefined();
  });

  it("lets only the system approve automatically, and only a rendered version", () => {
    const rows = PIPELINE_TRANSITIONS.filter((row) => row.via === "auto_approve");

    expect(rows).toEqual([
      {
        from: "review",
        to: "approved",
        via: "auto_approve",
        actors: ["system"],
        requiresRender: true,
      },
    ]);
    expect(
      findTransition({ from: "review", to: "approved", actor: "system", version: rendered })?.via,
    ).toBe("auto_approve");
    expect(canTransition("review", "approved", "system", voiced)).toBe(false);
    expect(canTransition("review", "approved", "device", rendered)).toBe(false);
    expect(canTransition("review", "approved", "token", rendered)).toBe(false);
  });

  it("requires a render to approve, submit, schedule and publish", () => {
    for (const via of ["approve", "auto_approve", "submit", "schedule", "unschedule", "publish"]) {
      for (const row of PIPELINE_TRANSITIONS.filter((candidate) => candidate.via === via)) {
        expect(row.requiresRender, via).toBe(true);
      }
    }
    expect(canTransition("review", "approved", "user", rendered)).toBe(true);
    expect(canTransition("review", "approved", "user", voiced)).toBe(false);
    expect(canTransition("review", "approved", "user", null)).toBe(false);
  });

  it("sends an edited approved item back to script or storyboard", () => {
    expect(findTransition({ from: "approved", to: "script", actor: "user" })?.via).toBe("edit");
    expect(findTransition({ from: "approved", to: "storyboard", actor: "user" })?.via).toBe("edit");
    expect(canTransition("approved", "script", "device")).toBe(false);
    expect(canTransition("approved", "render", "user", bare)).toBe(false);
    expect(canTransition("approved", "render", "device", rendered)).toBe(false);
  });

  it("restores an archived item as an idea", () => {
    expect(findTransition({ from: "archived", to: "idea", actor: "user" })?.via).toBe("restore");
    expect(canTransition("archived", "script", "user", rendered)).toBe(false);
  });

  it("maps review decisions to the rows that carry them out", () => {
    for (const [decision, to] of Object.entries(REVIEW_DECISION_STATES)) {
      const row = findTransition({
        from: "review",
        to,
        actor: "user",
        via: decision as keyof typeof REVIEW_DECISION_STATES,
        version: rendered,
      });

      expect(row?.via, decision).toBe(decision);
    }
  });

  it("finds rows by kind of move", () => {
    expect(findTransition({ from: "review", to: "script", actor: "user" })).toBeDefined();
    expect(
      findTransition({ from: "review", to: "script", actor: "device", via: "request_changes" }),
    ).toBeUndefined();
    expect(
      findTransition({ from: "review", to: "archived", actor: "user", via: "reject" })?.via,
    ).toBe("reject");
  });
});

describe("stage for artifacts", () => {
  it("is the last artifact present without a gap", () => {
    expect(stageForArtifacts(bare)).toBe("idea");
    expect(stageForArtifacts(scripted)).toBe("script");
    expect(stageForArtifacts({ ...scripted, storyboard: {} })).toBe("storyboard");
    expect(stageForArtifacts(voiced)).toBe("voice");
    expect(stageForArtifacts(rendered)).toBe("render");
    expect(stageForArtifacts({ script: {}, voiceAssetId: "voice", renderAssetId: "r" })).toBe(
      "script",
    );
    expect(stageForArtifacts({ script: null, storyboard: {} })).toBe("idea");
  });

  it("reads version summaries", () => {
    expect(stageForArtifacts({ hasScript: true, hasStoryboard: false })).toBe("script");
    expect(stageForArtifacts({ hasScript: true, hasStoryboard: true, voiceAssetId: "v" })).toBe(
      "voice",
    );
    expect(stageForArtifacts({ hasScript: false, hasStoryboard: true })).toBe("idea");
  });

  it("names the next production step", () => {
    expect(nextProductionStep(bare)).toBe("write_script");
    expect(nextProductionStep(scripted)).toBe("storyboard");
    expect(nextProductionStep({ ...scripted, storyboard: {} })).toBe("voice");
    expect(nextProductionStep(voiced)).toBe("render");
    expect(nextProductionStep(rendered)).toBeNull();
  });
});

describe("allowed actions", () => {
  const actions = (
    state: PipelineState,
    version: VersionArtifacts | null,
    actor: ActorKind = "user",
  ): ItemAction[] => allowedActions(state, actor, actor === "user" ? "owner" : null, version);

  it("offers a new idea its first step", () => {
    expect(actions("idea", null)).toEqual(["write_script", "produce", "edit", "archive"]);
    expect(actions("idea", bare)).toEqual(["write_script", "produce", "edit", "archive"]);
  });

  it("offers each step once its input exists", () => {
    expect(actions("script", scripted)).toEqual([
      "write_script",
      "storyboard",
      "revise",
      "produce",
      "edit",
      "archive",
    ]);
    expect(actions("voice", voiced)).toEqual([
      "write_script",
      "storyboard",
      "voice",
      "render",
      "revise",
      "produce",
      "edit",
      "archive",
    ]);
    expect(actions("render", rendered)).toContain("submit");
    expect(actions("voice", voiced)).not.toContain("submit");
  });

  it("offers review decisions on a rendered version in review", () => {
    const inReview = actions("review", rendered);

    expect(inReview).toEqual(
      expect.arrayContaining(["approve", "request_changes", "reject", "edit", "archive"]),
    );
    expect(inReview).not.toContain("produce");
    expect(actions("review", voiced)).not.toContain("approve");
    expect(actions("review", voiced)).toContain("request_changes");
  });

  it("limits approved, scheduled, published and archived items", () => {
    expect(actions("approved", rendered)).toEqual(["edit", "archive"]);
    expect(actions("scheduled", rendered)).toEqual(["archive"]);
    expect(actions("published", rendered)).toEqual(["archive"]);
    expect(actions("archived", rendered)).toEqual(["restore"]);
  });

  it("gives autopilot production work but no decisions", () => {
    expect(actions("render", rendered, "system")).toEqual([
      "write_script",
      "storyboard",
      "voice",
      "render",
      "revise",
      "produce",
      "submit",
    ]);
    expect(actions("review", rendered, "system")).not.toContain("approve");
  });

  it("lets devices and tokens only submit", () => {
    for (const actor of ["device", "token"] as const) {
      for (const state of PIPELINE_STATES) {
        for (const action of actions(state, rendered, actor)) expect(action).toBe("submit");
      }
    }
  });

  it("gives a user without a role nothing", () => {
    expect(allowedActions("review", "user", null, rendered)).toEqual([]);
    expect(allowedActions("review", "user", "admin", rendered)).toEqual(
      allowedActions("review", "user", "owner", rendered),
    );
  });

  it("only returns known actions, in a stable order", () => {
    for (const state of PIPELINE_STATES) {
      const list = actions(state, rendered);
      const order = list.map((action) => ITEM_ACTIONS.indexOf(action));

      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });
});
