import { randomUUID } from "node:crypto";
import {
  ProgressListOutputSchema,
  type ProgressReportInput,
  ProgressReportOutputSchema,
  ProgressReportSchema,
} from "@loomcast/contracts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { progressServiceFor } from "../src/modules/progress";
import {
  connectClient,
  issueJobToken,
  issueToken,
  type McpTestServer,
  startMcpTestServer,
} from "./mcp-support";
import {
  call,
  createPipelineHarness,
  eventsOf,
  insertAsset,
  insertItem,
  insertWorkspace,
  type PipelineHarness,
} from "./pipeline-support";

let h: PipelineHarness;
let workspaceId: string;
let otherWorkspaceId: string;

beforeAll(async () => {
  h = await createPipelineHarness();
  workspaceId = await insertWorkspace(h);
  otherWorkspaceId = await insertWorkspace(h);
});

afterAll(async () => {
  await h?.close();
});

const at = "2026-11-24T10:00:00.000Z";

function report(itemId: string, overrides: Partial<ProgressReportInput> = {}) {
  return ProgressReportSchema.parse({
    itemId,
    source: "content-machine",
    path: `brands/unfolded/content/${itemId.slice(0, 8)}`,
    style: "build-ladder",
    steps: [
      { key: "idea", status: "done" },
      { key: "research", status: "done", skill: "unfolded-explainer-reel" },
      { key: "script", status: "active", tool: "cm say" },
    ],
    revision: 1,
    reportedAt: at,
    ...overrides,
  });
}

describe("progress service", () => {
  it("stores a report, fills in the missing steps and works out the stage", async () => {
    const { itemId } = await insertItem(h, { workspaceId, title: "How a QR code works" });
    const progress = progressServiceFor(h.deps);
    const before = eventsOf(h.live, "content.progress.updated").length;

    const [result] = await progress.report(workspaceId, [report(itemId)]);
    expect(result).toEqual({ itemId, outcome: "stored", revision: 1 });

    const stored = await progress.get(itemId);
    expect(stored?.title).toBe("How a QR code works");
    expect(stored?.itemState).toBe("idea");
    expect(stored?.steps.map((step) => step.key)).toEqual([
      "idea",
      "research",
      "script",
      "voice",
      "visuals",
      "render",
      "checks",
      "ready",
      "scheduled",
      "published",
    ]);
    expect(stored?.steps[3]?.status).toBe("pending");
    expect(stored?.stage).toBe("script");
    expect(stored?.health).toBe("active");
    expect(eventsOf(h.live, "content.progress.updated")).toHaveLength(before + 1);
  });

  it("ignores an older revision, reports an identical one as unchanged and stores a newer one", async () => {
    const { itemId } = await insertItem(h, { workspaceId });
    const progress = progressServiceFor(h.deps);
    await progress.report(workspaceId, [report(itemId, { revision: 5 })]);

    const [same] = await progress.report(workspaceId, [report(itemId, { revision: 5 })]);
    expect(same?.outcome).toBe("unchanged");
    const [older] = await progress.report(workspaceId, [
      report(itemId, { revision: 4, style: "other" }),
    ]);
    expect(older).toEqual({ itemId, outcome: "stale", revision: 5 });

    const failing = report(itemId, {
      revision: 6,
      steps: [
        { key: "idea", status: "done" },
        { key: "research", status: "failed", error: "No source for the top speed" },
      ],
    });
    const [newer] = await progress.report(workspaceId, [failing]);
    expect(newer).toEqual({ itemId, outcome: "stored", revision: 6 });
    const stored = await progress.get(itemId);
    expect(stored?.stage).toBe("research");
    expect(stored?.health).toBe("failed");
    expect(stored?.style).toBe("build-ladder");
  });

  it("refuses items of another workspace and previews that are not ready assets of the item", async () => {
    const { itemId } = await insertItem(h, { workspaceId });
    const { itemId: foreignItem } = await insertItem(h, { workspaceId: otherWorkspaceId });
    const pending = await insertAsset(h.db, {
      workspaceId,
      itemId,
      kind: "poster",
      status: "pending",
    });
    const otherItemsPoster = await insertAsset(h.db, {
      workspaceId: otherWorkspaceId,
      itemId: foreignItem,
      kind: "poster",
    });
    const poster = await insertAsset(h.db, { workspaceId, itemId, kind: "poster" });
    const progress = progressServiceFor(h.deps);

    const results = await progress.report(workspaceId, [
      report(foreignItem),
      report(randomUUID()),
      report(itemId, { previewAssetId: pending }),
      report(itemId, { previewAssetId: otherItemsPoster }),
      report(itemId, { previewAssetId: poster }),
    ]);
    expect(results.map((result) => result.outcome)).toEqual([
      "not_found",
      "not_found",
      "invalid_preview",
      "invalid_preview",
      "stored",
    ]);
    expect((await progress.get(itemId))?.previewAssetId).toBe(poster);
    expect(await progress.get(foreignItem)).toBeNull();
  });

  it("does nothing when the done steps cover everything", async () => {
    const { itemId } = await insertItem(h, { workspaceId });
    const progress = progressServiceFor(h.deps);
    const steps = (
      [
        "idea",
        "research",
        "script",
        "voice",
        "visuals",
        "render",
        "checks",
        "ready",
        "scheduled",
      ] as const
    ).map((key) => ({ key, status: key === "voice" ? "skipped" : "done" }) as const);
    await progress.report(workspaceId, [
      report(itemId, { steps: [...steps, { key: "published", status: "done" }] }),
    ]);
    const stored = await progress.get(itemId);
    expect(stored?.stage).toBe("published");
    expect(stored?.health).toBe("done");
  });
});

describe("progress routes", () => {
  it("lists a workspace's progress, newest first, and reads one item", async () => {
    const workspace = await insertWorkspace(h);
    const first = await insertItem(h, { workspaceId: workspace, title: "First" });
    const second = await insertItem(h, { workspaceId: workspace, title: "Second" });
    const progress = progressServiceFor(h.deps);
    await progress.report(workspace, [report(first.itemId)]);
    await progress.report(workspace, [report(second.itemId)]);

    const list = await call(h, "GET", `/api/workspaces/${workspace}/progress`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { title: string }[] };
    expect(body.items.map((item) => item.title)).toEqual(["Second", "First"]);

    const one = await call(h, "GET", `/api/content/${first.itemId}/progress`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { path: string }).path).toContain("brands/unfolded/content/");
  });

  it("answers 404 for an unknown workspace or an item without progress", async () => {
    expect((await call(h, "GET", `/api/workspaces/${randomUUID()}/progress`)).status).toBe(404);
    const { itemId } = await insertItem(h, { workspaceId });
    expect((await call(h, "GET", `/api/content/${itemId}/progress`)).status).toBe(404);
  });

  it("needs a session", async () => {
    const response = await h.t.app.request(`/api/workspaces/${workspaceId}/progress`);
    expect(response.status).toBe(401);
  });
});

describe("progress MCP tools", () => {
  let server: McpTestServer;
  let writer: Client;
  let reader: Client;

  beforeAll(async () => {
    server = await startMcpTestServer(h.db);
    writer = await connectClient(
      server.url,
      (await issueToken(server.deps, h.userId, ["mcp:read", "mcp:write"])).secret,
    );
    reader = await connectClient(
      server.url,
      (await issueToken(server.deps, h.userId, ["mcp:read"])).secret,
    );
  });

  afterAll(async () => {
    await writer?.close();
    await reader?.close();
    await server?.close();
  });

  it("reports and lists progress for a workspace named by its id", async () => {
    const workspace = await insertWorkspace(h);
    const { itemId } = await insertItem(h, { workspaceId: workspace });
    const reported = await writer.callTool({
      name: "progress.report",
      arguments: {
        workspace,
        items: [{ ...report(itemId), steps: [{ key: "idea", status: "done" }] }],
      },
    });
    expect(reported.isError).toBeFalsy();
    expect(ProgressReportOutputSchema.parse(reported.structuredContent).results).toEqual([
      { itemId, outcome: "stored", revision: 1 },
    ]);

    const listed = await reader.callTool({ name: "progress.list", arguments: { workspace } });
    const items = ProgressListOutputSchema.parse(listed.structuredContent).items;
    expect(items.map((item) => [item.itemId, item.stage])).toEqual([[itemId, "research"]]);
  });

  it("refuses a report from a read-only token or a job token", async () => {
    const { itemId } = await insertItem(h, { workspaceId });
    const args = { workspace: workspaceId, items: [report(itemId)] };
    const readOnly = await reader.callTool({ name: "progress.report", arguments: args });
    expect(readOnly.isError).toBe(true);

    const issued = await issueJobToken(h.db, {
      userId: h.userId,
      workspaceId,
      scopes: ["mcp:read", "mcp:write"],
    });
    const job = await connectClient(server.url, issued.secret);
    try {
      const refused = await job.callTool({ name: "progress.report", arguments: args });
      expect(refused.isError).toBe(true);
    } finally {
      await job.close();
    }
  });

  it("does not show another workspace's item through progress.get", async () => {
    const { itemId } = await insertItem(h, { workspaceId: otherWorkspaceId });
    await progressServiceFor(h.deps).report(otherWorkspaceId, [report(itemId)]);
    const result = await reader.callTool({
      name: "progress.get",
      arguments: { workspace: workspaceId, itemId },
    });
    expect(result.structuredContent).toEqual({ progress: null });
  });
});
