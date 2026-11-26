import { randomUUID } from "node:crypto";
import {
  DEFAULT_FORMAT_RULES,
  listSchema,
  type ProgressReportInput,
  ProgressReportSchema,
  type ProgressStep,
  SkillUsageItemSchema,
  SkillUsageSchema,
  WorkspaceSkillsSchema,
} from "@loomcast/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatsServiceFor } from "../src/modules/formats";
import { progressServiceFor } from "../src/modules/progress";
import { aggregateUsage, itemSkillUse, skillsServiceFor } from "../src/modules/skills";
import {
  call,
  createPipelineHarness,
  insertItem,
  insertWorkspace,
  type PipelineHarness,
  userOf,
} from "./pipeline-support";

let h: PipelineHarness;
let workspaceId: string;
let otherWorkspaceId: string;
let counter = 0;

/** A skill name no other test uses, so the global usage stays predictable. */
function uniqueName(label: string): string {
  counter += 1;
  return `${label}-${counter}-${randomUUID().slice(0, 6)}`;
}

beforeAll(async () => {
  h = await createPipelineHarness();
  workspaceId = await insertWorkspace(h);
  otherWorkspaceId = await insertWorkspace(h);
});

afterAll(async () => {
  await h?.close();
});

const at = "2026-11-24T10:00:00.000Z";

function step(overrides: Partial<ProgressStep> & Pick<ProgressStep, "key">): ProgressStep {
  return {
    status: "done",
    skill: null,
    tool: null,
    startedAt: null,
    finishedAt: null,
    note: null,
    error: null,
    ...overrides,
  };
}

function report(itemId: string, steps: ProgressReportInput["steps"], revision = 1) {
  return ProgressReportSchema.parse({
    itemId,
    source: "content-machine",
    path: `brands/unfolded/content/${itemId.slice(0, 8)}`,
    steps,
    revision,
    reportedAt: at,
  });
}

async function publish(name: string, kind: "skill" | "recipe" = "skill") {
  await skillsServiceFor(h.deps).publish(
    {
      name,
      kind,
      files: [
        { path: "SKILL.md", content: `# ${name}` },
        {
          path: "skill.json",
          content: JSON.stringify({ name, kind, description: `About ${name}.` }),
        },
      ],
    },
    userOf(h),
  );
}

describe("aggregateUsage", () => {
  const rows = [
    {
      itemId: "a",
      reportedAt: new Date("2026-11-20T00:00:00.000Z"),
      steps: [
        step({ key: "idea" }),
        step({ key: "script", skill: "reels-scripting", finishedAt: "2026-11-21T09:00:00.000Z" }),
        step({ key: "voice", skill: "voiceover", tool: "cm say" }),
        step({ key: "research", skill: "reels-scripting", tool: "cm analyze" }),
      ],
    },
    {
      itemId: "b",
      reportedAt: new Date("2026-11-22T00:00:00.000Z"),
      steps: [
        step({ key: "voice", tool: "cm say", startedAt: "2026-11-23T08:00:00.000Z" }),
        step({ key: "script", skill: "reels-scripting" }),
      ],
    },
  ];

  it("counts items, steps in step order and the last use per skill, skipping steps without one", () => {
    expect(aggregateUsage(rows, "skill")).toEqual([
      {
        name: "reels-scripting",
        items: 2,
        steps: ["research", "script"],
        lastUsedAt: "2026-11-22T00:00:00.000Z",
      },
      { name: "voiceover", items: 1, steps: ["voice"], lastUsedAt: "2026-11-20T00:00:00.000Z" },
    ]);
  });

  it("counts tools the same way, preferring a step's own times to the report's", () => {
    expect(aggregateUsage(rows, "tool")).toEqual([
      { name: "cm say", items: 2, steps: ["voice"], lastUsedAt: "2026-11-23T08:00:00.000Z" },
      {
        name: "cm analyze",
        items: 1,
        steps: ["research"],
        lastUsedAt: "2026-11-20T00:00:00.000Z",
      },
    ]);
  });

  it("is empty when no step names a skill", () => {
    expect(
      aggregateUsage([{ ...rows[0], steps: [step({ key: "idea" })] } as never], "skill"),
    ).toEqual([]);
    expect(itemSkillUse(rows[1] as never, "voiceover")).toBeNull();
  });
});

describe("skill usage routes", () => {
  it("aggregates a workspace's skills and tools, marks registered skills and lists its recipes", async () => {
    const registered = uniqueName("explainer");
    const unknown = uniqueName("not-published");
    const recipe = uniqueName("recipe");
    await publish(registered);
    await publish(recipe, "recipe");
    await formatsServiceFor(h.deps).create(
      workspaceId,
      {
        name: "Explainers",
        rules: { ...structuredClone(DEFAULT_FORMAT_RULES), recipe: { name: recipe, version: 1 } },
      },
      userOf(h),
    );

    const { itemId: first } = await insertItem(h, { workspaceId, title: "How a QR code works" });
    const { itemId: second } = await insertItem(h, { workspaceId, title: "Why ice floats" });
    const { itemId: foreign } = await insertItem(h, { workspaceId: otherWorkspaceId });
    const progress = progressServiceFor(h.deps);
    await progress.report(workspaceId, [
      report(first, [
        { key: "idea", status: "done" },
        { key: "script", status: "done", skill: registered, tool: "cm say" },
        { key: "voice", status: "active", skill: unknown },
      ]),
      report(second, [{ key: "script", status: "done", skill: registered }]),
    ]);
    await progress.report(otherWorkspaceId, [
      report(foreign, [{ key: "render", status: "done", skill: registered, tool: "cm render" }]),
    ]);

    const response = await call(h, "GET", `/api/workspaces/${workspaceId}/skills`);
    expect(response.status).toBe(200);
    const body = WorkspaceSkillsSchema.parse(await response.json());
    expect(body.workspaceId).toBe(workspaceId);
    const byName = new Map(body.skills.map((entry) => [entry.name, entry]));
    expect(byName.get(registered)).toMatchObject({
      items: 2,
      steps: ["script"],
      registry: { kind: "skill", latestVersion: 1, description: `About ${registered}.` },
    });
    expect(byName.get(unknown)).toMatchObject({ items: 1, steps: ["voice"], registry: null });
    expect(body.tools.map((tool) => tool.name)).toEqual(["cm say"]);
    expect(body.recipes).toEqual([
      expect.objectContaining({
        formatName: "Explainers",
        name: recipe,
        version: 1,
        registry: expect.objectContaining({ kind: "recipe", latestVersion: 1 }),
      }),
    ]);

    const other = WorkspaceSkillsSchema.parse(
      await (await call(h, "GET", `/api/workspaces/${otherWorkspaceId}/skills`)).json(),
    );
    expect(other.skills.map((entry) => [entry.name, entry.items, entry.steps])).toEqual([
      [registered, 1, ["render"]],
    ]);
    expect(other.tools.map((tool) => tool.name)).toEqual(["cm render"]);
    expect(other.recipes).toEqual([]);

    const all = listSchema(SkillUsageSchema).parse(
      await (await call(h, "GET", "/api/skill-usage")).json(),
    );
    expect(all.items.find((entry) => entry.name === registered)).toMatchObject({
      items: 3,
      steps: ["script", "render"],
    });
    expect(all.items.find((entry) => entry.name === unknown)?.registry).toBeNull();
  });

  it("lists the items in every workspace that used a skill, with their workspace and stage", async () => {
    const name = uniqueName("voice");
    const { itemId: mine } = await insertItem(h, { workspaceId, title: "Mine" });
    const { itemId: theirs } = await insertItem(h, {
      workspaceId: otherWorkspaceId,
      title: "Theirs",
    });
    const { itemId: unrelated } = await insertItem(h, { workspaceId });
    const progress = progressServiceFor(h.deps);
    await progress.report(workspaceId, [
      report(mine, [
        { key: "idea", status: "done" },
        { key: "voice", status: "failed", skill: name, error: "No voice" },
      ]),
      report(unrelated, [{ key: "voice", status: "done", skill: uniqueName("other") }]),
    ]);
    await progress.report(otherWorkspaceId, [
      report(theirs, [
        {
          key: "voice",
          status: "done",
          skill: name,
          finishedAt: "2026-11-25T10:00:00.000Z",
        },
      ]),
    ]);

    const response = await call(h, "GET", `/api/skills/${name}/usage`);
    expect(response.status).toBe(200);
    const { items } = listSchema(SkillUsageItemSchema).parse(await response.json());
    expect(items.map((item) => [item.title, item.workspaceId, item.stage, item.health])).toEqual([
      ["Theirs", otherWorkspaceId, "voice", "idle"],
      ["Mine", workspaceId, "voice", "failed"],
    ]);
    expect(items[1]?.steps).toEqual(["voice"]);
    expect(items[1]?.workspaceSlug).toMatch(/^pipeline-/);
  });

  it("returns no items for an unused name, 404 for a name that is not a skill name or an unknown workspace", async () => {
    const unused = await call(h, "GET", `/api/skills/${uniqueName("unused")}/usage`);
    expect(unused.status).toBe(200);
    expect(await unused.json()).toEqual({ items: [] });
    expect((await call(h, "GET", "/api/skills/Not%20A%20Skill/usage")).status).toBe(404);
    expect((await call(h, "GET", `/api/workspaces/${randomUUID()}/skills`)).status).toBe(404);
  });

  it("needs a session", async () => {
    for (const path of [
      `/api/workspaces/${workspaceId}/skills`,
      "/api/skill-usage",
      "/api/skills/voiceover/usage",
    ]) {
      expect((await h.t.app.request(path)).status).toBe(401);
    }
  });
});
