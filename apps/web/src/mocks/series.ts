import {
  type ApiError,
  CreateSeriesRequestSchema,
  routes,
  type Series,
  slugify,
  UpdateSeriesRequestSchema,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { z } from "zod";
import { mockSeries, updateContentItem } from "./content";
import type { MockDb } from "./db";
import { ensureFormats } from "./formats";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json<ApiError>(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");
const seriesNotFound = () => apiError(404, "not_found", "No series has that id.");

function invalid(error: z.ZodError) {
  return apiError(
    400,
    "validation_failed",
    "The request is not valid.",
    error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}

function touch(series: Series) {
  series.updatedAt = new Date(Math.max(Date.now(), Date.parse(series.updatedAt) + 1)).toISOString();
}

/**
 * What pausing does to plans, as the scheduler will: future ideas of the series that were planned
 * for a slot (they have a target and were never started) are archived.
 */
function archivePlannedIdeas(db: MockDb, seriesId: string) {
  const now = Date.now();
  for (const item of db.contentItems) {
    if (
      item.seriesId === seriesId &&
      item.state === "idea" &&
      item.createdVia === "system" &&
      item.targetAt &&
      Date.parse(item.targetAt) > now
    ) {
      updateContentItem(db, item.id, (entry) => {
        entry.state = "archived";
        entry.archivedAt = new Date().toISOString();
      });
    }
  }
}

/** Creating, renaming, pausing, resuming and archiving series. Listing lives with the content mocks. */
export function createSeriesHandlers(db: MockDb) {
  const find = (id: string) => db.series.find((series) => series.id === id);

  return [
    http.post(path("series.create"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const workspace = db.workspaces.find((entry) => entry.id === params.workspaceId);
      if (!workspace) return apiError(404, "not_found", "No workspace has that id.");
      if (workspace.status === "archived") {
        return apiError(409, "conflict", "The workspace is archived.");
      }
      const parsed = CreateSeriesRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      ensureFormats(db);
      const format = db.formats.find((entry) => entry.id === parsed.data.formatId);
      if (!format || format.workspaceId !== workspace.id) {
        return apiError(400, "validation_failed", "The request is not valid.", [
          { path: "formatId", message: "The format is not in this workspace." },
        ]);
      }
      const taken = new Set(
        db.series
          .filter((series) => series.workspaceId === workspace.id)
          .map((series) => series.slug),
      );
      let slug = parsed.data.slug ?? (slugify(parsed.data.name) || "series");
      for (let n = 2; taken.has(slug); n += 1) slug = `${slugify(parsed.data.name)}-${n}`;
      const series = mockSeries({
        workspaceId: workspace.id,
        name: parsed.data.name,
        slug,
        formatId: format.id,
      });
      db.series.push(series);
      return HttpResponse.json(series, { status: 201 });
    }),

    http.patch(path("series.update"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const series = find(String(params.id));
      if (!series) return seriesNotFound();
      const parsed = UpdateSeriesRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      if (parsed.data.formatId !== undefined) {
        ensureFormats(db);
        const format = db.formats.find((entry) => entry.id === parsed.data.formatId);
        if (!format || format.workspaceId !== series.workspaceId) {
          return apiError(400, "validation_failed", "The request is not valid.", [
            { path: "formatId", message: "The format is not in this workspace." },
          ]);
        }
        series.formatId = format.id;
      }
      if (parsed.data.name !== undefined) series.name = parsed.data.name;
      touch(series);
      return HttpResponse.json(series);
    }),

    http.post(path("series.pause"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const series = find(String(params.id));
      if (!series) return seriesNotFound();
      if (series.status === "archived") {
        return apiError(409, "conflict", "An archived series can't be paused.");
      }
      if (series.status !== "paused") {
        series.status = "paused";
        touch(series);
        archivePlannedIdeas(db, series.id);
      }
      return HttpResponse.json(series);
    }),

    http.post(path("series.resume"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const series = find(String(params.id));
      if (!series) return seriesNotFound();
      if (series.status === "archived") {
        return apiError(409, "conflict", "An archived series can't be resumed.");
      }
      if (series.status !== "active") {
        series.status = "active";
        touch(series);
      }
      return HttpResponse.json(series);
    }),

    http.post(path("series.archive"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const series = find(String(params.id));
      if (!series) return seriesNotFound();
      if (series.status !== "archived") {
        archivePlannedIdeas(db, series.id);
        series.status = "archived";
        series.archivedAt = new Date().toISOString();
        touch(series);
      }
      return HttpResponse.json(series);
    }),
  ];
}
