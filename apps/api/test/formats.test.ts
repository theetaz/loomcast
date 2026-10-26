import {
  DEFAULT_FORMAT_RULES,
  type Format,
  type FormatRules,
  FormatSchema,
  FormatVersionSchema,
  listSchema,
} from "@loomcast/contracts";
import { auditLog, formatVersions } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatsServiceFor } from "../src/modules/formats";
import {
  call,
  createPipelineHarness,
  insertWorkspace,
  internalOf,
  type PipelineHarness,
} from "./pipeline-support";
import { errorCode } from "./support";

let h: PipelineHarness;
let workspaceId: string;

beforeAll(async () => {
  h = await createPipelineHarness();
  workspaceId = await insertWorkspace(h);
});

afterAll(async () => {
  await h.close();
});

function rules(overrides: Partial<FormatRules> = {}): FormatRules {
  return { ...structuredClone(DEFAULT_FORMAT_RULES), ...overrides };
}

async function createFormat(
  body: Record<string, unknown>,
  workspace = workspaceId,
): Promise<Format> {
  const response = await call(h, "POST", `/api/workspaces/${workspace}/formats`, body);
  expect(response.status).toBe(201);
  return FormatSchema.parse(await response.json());
}

describe("formats", () => {
  it("creates a format with version 1 of the default rules and a derived slug", async () => {
    const format = await createFormat({ name: "Rust in 60 Seconds" });
    expect(format.slug).toBe("rust-in-60-seconds");
    expect(format.currentVersion.versionNo).toBe(1);
    expect(format.currentVersion.rules).toEqual(DEFAULT_FORMAT_RULES);
    expect(format.currentVersion.createdBy).toBe(h.userId);

    const second = await createFormat({ name: "Rust in 60 Seconds" });
    expect(second.slug).toBe("rust-in-60-seconds-2");

    const taken = await call(h, "POST", `/api/workspaces/${workspaceId}/formats`, {
      name: "Other",
      slug: "rust-in-60-seconds",
    });
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe("conflict");
  });

  it("stores every update as a new version and moves the current version", async () => {
    const format = await createFormat({ name: "Versioned", rules: rules({ tone: "Calm" }) });
    expect(format.currentVersion.rules.tone).toBe("Calm");

    const v2 = await call(h, "PATCH", `/api/formats/${format.id}`, {
      baseVersionId: format.currentVersion.id,
      rules: rules({ tone: "Energetic", voiceId: "voice-1" }),
    });
    expect(v2.status).toBe(200);
    const updated = FormatSchema.parse(await v2.json());
    expect(updated.currentVersion.versionNo).toBe(2);
    expect(updated.currentVersion.rules.tone).toBe("Energetic");
    expect(updated.name).toBe("Versioned");

    // A rename alone is a version too, with the rules copied forward.
    const v3 = await call(h, "PATCH", `/api/formats/${format.id}`, {
      baseVersionId: updated.currentVersion.id,
      name: "Renamed",
    });
    const renamed = FormatSchema.parse(await v3.json());
    expect(renamed.name).toBe("Renamed");
    expect(renamed.currentVersion.versionNo).toBe(3);
    expect(renamed.currentVersion.rules).toEqual(updated.currentVersion.rules);

    const versions = await call(h, "GET", `/api/formats/${format.id}/versions`);
    const { items } = listSchema(FormatVersionSchema).parse(await versions.json());
    expect(items.map((version) => version.versionNo)).toEqual([3, 2, 1]);
    expect(items[2]?.rules.tone).toBe("Calm");

    const events = internalOf(h.internal, "format.updated").filter(
      (event) => event.payload.formatId === format.id,
    );
    expect(events.map((event) => event.payload.versionId)).toEqual([
      updated.currentVersion.id,
      renamed.currentVersion.id,
    ]);
    expect(events[0]?.payload.previousVersionId).toBe(format.currentVersion.id);

    const audits = await h.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, format.id));
    expect(audits.map((entry) => entry.action).sort()).toEqual([
      "format.created",
      "format.updated",
      "format.updated",
    ]);
  });

  it("refuses an update on a stale version with 409 and changes nothing", async () => {
    const format = await createFormat({ name: "Stale" });
    const first = await call(h, "PATCH", `/api/formats/${format.id}`, {
      baseVersionId: format.currentVersion.id,
      rules: rules({ tone: "First" }),
    });
    expect(first.status).toBe(200);

    const stale = await call(h, "PATCH", `/api/formats/${format.id}`, {
      baseVersionId: format.currentVersion.id,
      rules: rules({ tone: "Second" }),
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details.reason).toBe("stale_version");

    const rows = await h.db
      .select({ versionNo: formatVersions.versionNo })
      .from(formatVersions)
      .where(eq(formatVersions.formatId, format.id));
    expect(rows).toHaveLength(2);
    const current = FormatSchema.parse(
      await (await call(h, "GET", `/api/formats/${format.id}`)).json(),
    );
    expect(current.currentVersion.rules.tone).toBe("First");
  });

  it("lists the formats of a workspace and answers 404 for unknown ones", async () => {
    const other = await insertWorkspace(h);
    const format = await createFormat({ name: "Alpha" }, other);
    const response = await call(h, "GET", `/api/workspaces/${other}/formats`);
    const { items } = listSchema(FormatSchema).parse(await response.json());
    expect(items.map((item) => item.id)).toEqual([format.id]);

    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await call(h, "GET", `/api/workspaces/${missing}/formats`)).status).toBe(404);
    expect((await call(h, "GET", `/api/formats/${missing}`)).status).toBe(404);
    expect((await call(h, "GET", `/api/formats/${missing}/versions`)).status).toBe(404);
    const update = await call(h, "PATCH", `/api/formats/${missing}`, {
      baseVersionId: missing,
      name: "Nope",
    });
    expect(update.status).toBe(404);
  });

  it("refuses formats in an archived workspace and invalid rules", async () => {
    const archived = await insertWorkspace(h, "archived");
    const response = await call(h, "POST", `/api/workspaces/${archived}/formats`, { name: "Late" });
    expect(response.status).toBe(409);

    const invalid = await call(h, "POST", `/api/workspaces/${workspaceId}/formats`, {
      name: "Bad",
      rules: { ...rules(), lengthSec: { min: 60, max: 30 } },
    });
    expect(invalid.status).toBe(400);
  });

  it("gives a series' current rules as a job snapshot", async () => {
    const formats = formatsServiceFor(h.deps);
    const format = await createFormat({ name: "Snapshot" });
    const seriesResponse = await call(h, "POST", `/api/workspaces/${workspaceId}/series`, {
      name: "Snapshot series",
      formatId: format.id,
    });
    const series = (await seriesResponse.json()) as { id: string };
    const updated = await formats.update(
      format.id,
      { baseVersionId: format.currentVersion.id, rules: rules({ voiceId: "voice-2" }) },
      { kind: "user", id: h.userId, userId: h.userId },
    );
    expect(updated).not.toBeNull();

    const snapshot = await formats.snapshotForSeries(series.id);
    expect(snapshot?.formatVersionId).toBe(updated?.currentVersion.id);
    expect(snapshot?.rules.voiceId).toBe("voice-2");

    const forTool = await formats.rulesForSeries(series.id);
    expect(forTool).toMatchObject({ formatId: format.id, name: "Snapshot", version: 2 });
    expect(await formats.snapshotForSeries("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
