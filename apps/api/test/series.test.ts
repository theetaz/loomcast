import { FormatSchema, listSchema, type Series, SeriesSchema } from "@loomcast/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
let formatId: string;

beforeAll(async () => {
  h = await createPipelineHarness();
  workspaceId = await insertWorkspace(h);
  formatId = await newFormat(workspaceId);
});

afterAll(async () => {
  await h.close();
});

async function newFormat(workspace: string, name = "Format"): Promise<string> {
  const response = await call(h, "POST", `/api/workspaces/${workspace}/formats`, { name });
  expect(response.status).toBe(201);
  return FormatSchema.parse(await response.json()).id;
}

async function createSeries(name: string, format = formatId): Promise<Series> {
  const response = await call(h, "POST", `/api/workspaces/${workspaceId}/series`, {
    name,
    formatId: format,
  });
  expect(response.status).toBe(201);
  return SeriesSchema.parse(await response.json());
}

async function post(path: string): Promise<Response> {
  return call(h, "POST", path);
}

describe("series", () => {
  it("creates an active series of a format in the same workspace", async () => {
    const series = await createSeries("Rust Tips");
    expect(series).toMatchObject({ slug: "rust-tips", status: "active", formatId, workspaceId });
    expect((await createSeries("Rust Tips")).slug).toBe("rust-tips-2");

    const foreignFormat = await newFormat(await insertWorkspace(h));
    const response = await call(h, "POST", `/api/workspaces/${workspaceId}/series`, {
      name: "Foreign",
      formatId: foreignFormat,
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation_failed");

    const archived = await insertWorkspace(h, "archived");
    const refused = await call(h, "POST", `/api/workspaces/${archived}/series`, {
      name: "Late",
      formatId,
    });
    expect(refused.status).toBe(409);
  });

  it("renames a series and moves it to another format", async () => {
    const series = await createSeries("Movable");
    const otherFormat = await newFormat(workspaceId, "Other format");
    const response = await call(h, "PATCH", `/api/series/${series.id}`, {
      name: "Moved",
      formatId: otherFormat,
    });
    expect(response.status).toBe(200);
    const updated = SeriesSchema.parse(await response.json());
    expect(updated).toMatchObject({ name: "Moved", formatId: otherFormat, slug: "movable" });

    const [event] = internalOf(h.internal, "series.updated").filter(
      (entry) => entry.payload.seriesId === series.id,
    );
    expect(event?.payload).toMatchObject({ formatId: otherFormat, previousFormatId: formatId });
  });

  it("pauses, resumes and archives, and keeps archived series closed", async () => {
    const series = await createSeries("Lifecycle");
    const paused = SeriesSchema.parse(await (await post(`/api/series/${series.id}/pause`)).json());
    expect(paused.status).toBe("paused");
    // Pausing a paused series changes nothing.
    const again = SeriesSchema.parse(await (await post(`/api/series/${series.id}/pause`)).json());
    expect(again.updatedAt).toBe(paused.updatedAt);

    const resumed = SeriesSchema.parse(
      await (await post(`/api/series/${series.id}/resume`)).json(),
    );
    expect(resumed.status).toBe("active");

    const archived = SeriesSchema.parse(
      await (await post(`/api/series/${series.id}/archive`)).json(),
    );
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();

    expect((await post(`/api/series/${series.id}/resume`)).status).toBe(409);
    expect((await post(`/api/series/${series.id}/pause`)).status).toBe(409);
    expect((await post(`/api/series/${series.id}/archive`)).status).toBe(200);
    const rename = await call(h, "PATCH", `/api/series/${series.id}`, { name: "Revived" });
    expect(rename.status).toBe(409);

    const statuses = internalOf(h.internal, "series.updated")
      .filter((entry) => entry.payload.seriesId === series.id)
      .map((entry) => `${entry.payload.previousStatus}>${entry.payload.status}`);
    expect(statuses).toEqual(["active>paused", "paused>active", "active>archived"]);
  });

  it("lists series by status and answers 404 for unknown ones", async () => {
    const workspace = await insertWorkspace(h);
    const format = await newFormat(workspace);
    const make = async (name: string) => {
      const response = await call(h, "POST", `/api/workspaces/${workspace}/series`, {
        name,
        formatId: format,
      });
      return SeriesSchema.parse(await response.json());
    };
    const active = await make("A active");
    const paused = await make("B paused");
    await post(`/api/series/${paused.id}/pause`);

    const all = await call(h, "GET", `/api/workspaces/${workspace}/series`);
    const { items } = listSchema(SeriesSchema).parse(await all.json());
    expect(items.map((item) => item.id)).toEqual([active.id, paused.id]);

    const onlyPaused = await call(h, "GET", `/api/workspaces/${workspace}/series?status=paused`);
    const filtered = listSchema(SeriesSchema).parse(await onlyPaused.json());
    expect(filtered.items.map((item) => item.id)).toEqual([paused.id]);

    expect((await call(h, "GET", `/api/workspaces/${workspace}/series?status=nope`)).status).toBe(
      400,
    );
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await call(h, "GET", `/api/workspaces/${missing}/series`)).status).toBe(404);
    expect((await call(h, "GET", `/api/series/${missing}`)).status).toBe(404);
    expect((await post(`/api/series/${missing}/pause`)).status).toBe(404);
  });
});
