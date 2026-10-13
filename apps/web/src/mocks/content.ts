import {
  type ApiError,
  allowedActions,
  ContentActionRequestSchema,
  type ContentItem,
  type ContentItemDetail,
  type ContentVersion,
  type ContentVersionSummary,
  CreateContentItemRequestSchema,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_PRODUCE_TARGET,
  type JobSummary,
  type JobType,
  ListContentQuerySchema,
  MAX_PAGE_LIMIT,
  nextProductionStep,
  type PipelineState,
  PRODUCTION_STATES,
  PRODUCTION_STEPS,
  type ProduceTarget,
  type Project,
  routes,
  type Series,
  SeriesStatusSchema,
  slugify,
  UpdateContentItemRequestSchema,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { z } from "zod";
import { mockScript, mockStoryboard } from "./artifacts";
import { mockJob, updateJob } from "./conversations";
import { type MockDb, mockId, publish } from "./db";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");
const itemNotFound = () => apiError(404, "not_found", "No content item has that id.");

function invalid(error: z.ZodError) {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return apiError(400, "validation_failed", `${where}${issue?.message ?? "Check the request."}`);
}

/** A timestamp after `previous`, so two quick writes never share an `updatedAt`. */
function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

// Builders ----------------------------------------------------------------------

export function mockSeries(
  overrides: Partial<Series> & Pick<Series, "projectId" | "name">,
): Series {
  const at = overrides.createdAt ?? new Date().toISOString();
  return {
    id: mockId(),
    slug: slugify(overrides.name),
    formatId: mockId(),
    status: "active",
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    ...overrides,
  };
}

/** Artifacts a version at `stage` has. */
function artifactsFor(stage: PipelineState) {
  const reached = PRODUCTION_STATES.indexOf(stage as (typeof PRODUCTION_STATES)[number]);
  // Review and later states always have a render.
  const level = reached === -1 ? PRODUCTION_STATES.length - 1 : reached;
  return {
    hasScript: level >= 1,
    hasStoryboard: level >= 2,
    voiceAssetId: level >= 3 ? mockId() : null,
    renderAssetId: level >= 4 ? mockId() : null,
  };
}

export function mockVersion(
  overrides: Partial<ContentVersion> & Pick<ContentVersion, "itemId" | "versionNo" | "stage">,
): ContentVersion {
  const artifacts = artifactsFor(overrides.stage);
  // Real artifacts for the item page; a voice adds segment timings.
  const script = artifacts.hasScript
    ? mockScript(overrides.versionNo, { timed: artifacts.voiceAssetId !== null })
    : null;
  return {
    id: mockId(),
    parentVersionId: null,
    formatVersionId: null,
    ...artifacts,
    posterAssetId: artifacts.renderAssetId ? mockId() : null,
    notes: null,
    createdVia: overrides.versionNo === 1 ? "system" : "job",
    createdByUser: null,
    jobId: null,
    createdAt: new Date().toISOString(),
    script,
    storyboard: script && artifacts.hasStoryboard ? mockStoryboard(script) : null,
    caption: null,
    ...overrides,
  };
}

/**
 * A content item and the versions behind it: version 1 is the bare idea and every later version
 * moves it one stage on, up to its state.
 */
export function mockContentItem(
  overrides: Partial<ContentItem> & Pick<ContentItem, "projectId" | "title">,
): { item: ContentItem; versions: ContentVersion[] } {
  const id = overrides.id ?? mockId();
  const state = overrides.state ?? "idea";
  const at = overrides.createdAt ?? new Date().toISOString();
  const versionNo = overrides.versionNo ?? 1;
  // Earlier versions climb the production stages one at a time, up to the item's state.
  const reached = PRODUCTION_STATES.indexOf(state as (typeof PRODUCTION_STATES)[number]);
  const top = reached === -1 ? PRODUCTION_STATES.length - 1 : reached;
  const versions = Array.from({ length: versionNo }, (_, index) =>
    mockVersion({
      itemId: id,
      versionNo: index + 1,
      stage:
        index + 1 === versionNo
          ? state
          : (PRODUCTION_STATES[Math.min(index, Math.max(0, top - 1))] ?? "idea"),
      createdAt: at,
    }),
  );
  const current = versions.at(-1) as ContentVersion;
  const item: ContentItem = {
    id,
    seriesId: null,
    pitch: null,
    topic: null,
    state,
    currentVersionId: current.id,
    versionNo,
    durationMs: current.renderAssetId ? 42_000 : null,
    posterAssetId: current.posterAssetId,
    targetAt: null,
    autopilotTarget: null,
    lastError: null,
    createdVia: "ui",
    createdBy: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: state === "archived" ? at : null,
    ...overrides,
  };
  return { item, versions };
}

function summary(version: ContentVersion): ContentVersionSummary {
  const { script: _script, storyboard: _storyboard, caption: _caption, ...rest } = version;
  return rest;
}

function currentVersion(db: MockDb, item: ContentItem): ContentVersion | undefined {
  return db.contentVersions.find((version) => version.id === item.currentVersionId);
}

/** Changes a stored item, moves its `updatedAt` on and publishes `content.item.updated`. */
export function updateContentItem(
  db: MockDb,
  id: string,
  change: (item: ContentItem) => void,
): ContentItem | null {
  const item = db.contentItems.find((entry) => entry.id === id);
  if (!item) return null;
  change(item);
  item.updatedAt = nextTimestamp(item.updatedAt);
  publish(db, { type: "content.item.updated", payload: { item: { ...item } } });
  return item;
}

/** Stores a new version of an item at `stage`, points the item at it and publishes both events. */
export function addContentVersion(db: MockDb, itemId: string, stage: PipelineState, jobId: string) {
  const item = db.contentItems.find((entry) => entry.id === itemId);
  const base = item ? currentVersion(db, item) : undefined;
  if (!item || !base) return null;
  const version = mockVersion({
    itemId,
    versionNo: item.versionNo + 1,
    stage,
    parentVersionId: base.id,
    jobId,
  });
  db.contentVersions.push(version);
  const project = item.projectId;
  publish(db, {
    type: "content.version.created",
    payload: { projectId: project, version: summary(version) },
  });
  return updateContentItem(db, itemId, (entry) => {
    entry.state = stage;
    entry.currentVersionId = version.id;
    entry.versionNo = version.versionNo;
    entry.durationMs = version.renderAssetId ? 38_000 + Math.floor(Math.random() * 20_000) : null;
    entry.posterAssetId = version.posterAssetId;
    entry.lastError = null;
  });
}

function detailOf(db: MockDb, item: ContentItem): ContentItemDetail | null {
  const current = currentVersion(db, item);
  if (!current) return null;
  const versions = db.contentVersions
    .filter((version) => version.itemId === item.id)
    .sort((a, b) => b.versionNo - a.versionNo)
    .map(summary);
  const jobId = activeJobs(db).get(item.id);
  const activeJob = jobId ? (db.jobs.find((job) => job.id === jobId) ?? null) : null;
  return { item: { ...item }, currentVersion: current, versions, activeJob };
}

// The pretend production line ------------------------------------------------------

const jobsByDb = new WeakMap<MockDb, Map<string, string>>();

/** Production jobs queued or running, by item id. */
export function activeJobs(db: MockDb): Map<string, string> {
  let jobs = jobsByDb.get(db);
  if (!jobs) {
    jobs = new Map();
    jobsByDb.set(db, jobs);
  }
  return jobs;
}

const STEP_JOB_TYPES: Record<string, JobType> = {
  write_script: "content.write_script",
  storyboard: "content.storyboard",
  voice: "content.voice",
  render: "content.render",
  revise: "content.revise",
};

const STEP_MS = 1_400;

/** What the mock studio agent reports while it works on a step. */
const STEP_ACTIVITY: Record<string, string> = {
  write_script: "Writing the script",
  storyboard: "Laying out the storyboard",
  voice: "Recording the voice",
  render: "Rendering the video",
  revise: "Revising the script from the review",
};

function cancelRequested(db: MockDb, jobId: string): boolean {
  return Boolean(db.jobs.find((job) => job.id === jobId)?.cancelRequestedAt);
}

function reportActivity(db: MockDb, jobId: string, step: string, progress: number) {
  publish(db, {
    type: "job.activity",
    payload: { jobId, kind: step, summary: STEP_ACTIVITY[step] ?? "Working", progress },
  });
}

/**
 * Mock mode only: walks an item through the missing steps up to `through`, one version per step,
 * then sends a rendered item to review. Tests leave `simulateProducer` off and drive events.
 */
function runProduction(db: MockDb, itemId: string, jobId: string, through: ProduceTarget) {
  const stopAt = PRODUCTION_STATES.indexOf(through === "review" ? "render" : through);
  const advance = () => {
    const item = db.contentItems.find((entry) => entry.id === itemId);
    const version = item ? currentVersion(db, item) : undefined;
    if (!item || !version || item.state === "archived" || cancelRequested(db, jobId)) {
      finish("cancelled");
      return;
    }
    const step = nextProductionStep(version);
    const stage = PRODUCTION_STEPS.find((entry) => entry.action === step)?.stage;
    if (step && stage && PRODUCTION_STATES.indexOf(stage) <= stopAt) {
      updateJob(db, jobId, { type: STEP_JOB_TYPES[step] ?? "content.write_script" });
      reportActivity(db, jobId, step, PRODUCTION_STATES.indexOf(stage) / (stopAt + 1));
      addContentVersion(db, itemId, stage, jobId);
      setTimeout(advance, STEP_MS);
      return;
    }
    if (through === "review" && version.renderAssetId) {
      updateContentItem(db, itemId, (entry) => {
        entry.state = "review";
      });
    }
    finish("succeeded");
  };
  const finish = (status: JobSummary["status"]) => {
    activeJobs(db).delete(itemId);
    updateJob(db, jobId, { status, finishedAt: new Date().toISOString() });
  };
  setTimeout(() => {
    if (cancelRequested(db, jobId)) {
      activeJobs(db).delete(itemId);
      return;
    }
    const at = new Date().toISOString();
    updateJob(db, jobId, { status: "running", dispatchedAt: at, startedAt: at });
    advance();
  }, STEP_MS / 2);
}

/** The stage each single-step action writes a version at. `revise` rewrites the script. */
const STEP_STAGES: Record<string, PipelineState> = {
  write_script: "script",
  storyboard: "storyboard",
  voice: "voice",
  render: "render",
  revise: "script",
};

/**
 * Mock mode only: runs one production step (a regenerated voice, a render, a revision) and writes
 * its version, reporting progress on the way.
 */
export function runSingleStep(db: MockDb, itemId: string, jobId: string, step: string) {
  const stage = STEP_STAGES[step];
  const finish = (status: JobSummary["status"]) => {
    activeJobs(db).delete(itemId);
    updateJob(db, jobId, { status, finishedAt: new Date().toISOString() });
  };
  if (!stage) {
    finish("failed");
    return;
  }
  const progress = [0.2, 0.55, 0.85];
  setTimeout(() => {
    if (cancelRequested(db, jobId)) {
      activeJobs(db).delete(itemId);
      return;
    }
    const at = new Date().toISOString();
    updateJob(db, jobId, { status: "running", dispatchedAt: at, startedAt: at });
    progress.forEach((value, index) => {
      setTimeout(
        () => {
          if (!cancelRequested(db, jobId)) reportActivity(db, jobId, step, value);
        },
        (index * STEP_MS) / 2,
      );
    });
    setTimeout(() => {
      if (cancelRequested(db, jobId)) {
        finish("cancelled");
        return;
      }
      addContentVersion(db, itemId, stage, jobId);
      finish("succeeded");
    }, STEP_MS * 2);
  }, STEP_MS / 2);
}

// Handlers --------------------------------------------------------------------------

function inRange(value: string | null, from: string | undefined, to: string | undefined) {
  if (from === undefined && to === undefined) return true;
  if (value === null) return false;
  const time = Date.parse(value);
  return (
    (from === undefined || time >= Date.parse(from)) && (to === undefined || time <= Date.parse(to))
  );
}

/** Content items and series, following `@loomcast/contracts`. */
export function createContentHandlers(db: MockDb) {
  const findItem = (id: string) => db.contentItems.find((item) => item.id === id);
  const findProject = (id: string): Project | undefined =>
    db.projects.find((project) => project.id === id);

  return [
    http.get(path("series.list"), ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const projectId = String(params.projectId);
      if (!findProject(projectId)) return apiError(404, "not_found", "No project has that id.");
      const status = new URL(request.url).searchParams.get("status");
      const parsedStatus = status === null ? undefined : SeriesStatusSchema.safeParse(status);
      if (parsedStatus && !parsedStatus.success) {
        return apiError(400, "validation_failed", "Unknown series status.");
      }
      const items = db.series
        .filter(
          (series) =>
            series.projectId === projectId &&
            (!parsedStatus || series.status === parsedStatus.data),
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      return HttpResponse.json({ items });
    }),

    http.get(path("series.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const series = db.series.find((entry) => entry.id === params.id);
      return series
        ? HttpResponse.json(series)
        : apiError(404, "not_found", "No series has that id.");
    }),

    // Most recently updated first; the cursor is the offset of the next page.
    http.get(path("content.list"), ({ request }) => {
      if (!db.signedIn) return unauthorized();
      const url = new URL(request.url);
      const parsed = ListContentQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return invalid(parsed.error);
      const query = parsed.data;
      const q = query.q?.toLowerCase();
      const all = db.contentItems
        .filter(
          (item) =>
            (!query.projectId || item.projectId === query.projectId) &&
            (query.states ? query.states.includes(item.state) : item.state !== "archived") &&
            (!query.seriesId || item.seriesId === query.seriesId) &&
            (!q ||
              item.title.toLowerCase().includes(q) ||
              (item.pitch ?? "").toLowerCase().includes(q)) &&
            inRange(item.targetAt, query.targetFrom, query.targetTo),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
      const offset = Number(query.cursor ?? 0) || 0;
      const limit = Math.min(MAX_PAGE_LIMIT, query.limit ?? DEFAULT_PAGE_LIMIT);
      const items = all.slice(offset, offset + limit).map((item) => ({ ...item }));
      const next = offset + limit;
      return HttpResponse.json({ items, nextCursor: next < all.length ? String(next) : null });
    }),

    http.post(path("content.create"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const project = findProject(String(params.projectId));
      if (!project) return apiError(404, "not_found", "No project has that id.");
      if (project.status === "archived") {
        return apiError(409, "conflict", "The project is archived and takes no new items.");
      }
      const parsed = CreateContentItemRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) return invalid(parsed.error);
      const input = parsed.data;
      if (
        input.seriesId &&
        !db.series.some((series) => series.id === input.seriesId && series.projectId === project.id)
      ) {
        return apiError(400, "validation_failed", "seriesId: The series is not in this project.");
      }
      const { item, versions } = mockContentItem({
        projectId: project.id,
        title: input.title,
        pitch: input.pitch || null,
        topic: input.topic ?? null,
        seriesId: input.seriesId ?? null,
        targetAt: input.targetAt ?? null,
        createdBy: db.user.id,
      });
      db.contentItems.push(item);
      db.contentVersions.push(...versions);
      publish(db, { type: "content.item.created", payload: { item: { ...item } } });
      return HttpResponse.json(detailOf(db, item), { status: 201 });
    }),

    http.get(path("content.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const item = findItem(String(params.id));
      const detail = item ? detailOf(db, item) : null;
      return detail ? HttpResponse.json(detail) : itemNotFound();
    }),

    http.get(path("content.versions.list"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const item = findItem(String(params.id));
      if (!item) return itemNotFound();
      const items = db.contentVersions
        .filter((version) => version.itemId === item.id)
        .sort((a, b) => b.versionNo - a.versionNo)
        .map(summary);
      return HttpResponse.json({ items });
    }),

    http.patch(path("content.update"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const id = String(params.id);
      if (!findItem(id)) return itemNotFound();
      const parsed = UpdateContentItemRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) return invalid(parsed.error);
      const { title, pitch } = parsed.data;
      const item = updateContentItem(db, id, (entry) => {
        if (title !== undefined) entry.title = title;
        if (pitch !== undefined) entry.pitch = pitch || null;
      });
      return HttpResponse.json(item);
    }),

    http.post(path("content.archive"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const id = String(params.id);
      const found = findItem(id);
      if (!found) return itemNotFound();
      if (found.state === "archived") return HttpResponse.json(found);
      if (activeJobs(db).has(id)) {
        return apiError(409, "job_in_progress", "Wait for the running job, or cancel it first.");
      }
      const item = updateContentItem(db, id, (entry) => {
        entry.state = "archived";
        entry.archivedAt = new Date().toISOString();
      });
      return HttpResponse.json(item);
    }),

    http.post(path("content.restore"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const id = String(params.id);
      const found = findItem(id);
      if (!found) return itemNotFound();
      if (found.state !== "archived") {
        return apiError(409, "invalid_transition", "Only archived items can be restored.");
      }
      const item = updateContentItem(db, id, (entry) => {
        entry.state = "idea";
        entry.archivedAt = null;
      });
      return HttpResponse.json(item);
    }),

    http.post(path("content.actions"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const item = findItem(String(params.id));
      if (!item) return itemNotFound();
      const parsed = ContentActionRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const { action, through = DEFAULT_PRODUCE_TARGET } = parsed.data;
      if (activeJobs(db).has(item.id)) {
        return apiError(409, "job_in_progress", "This item already has a job queued or running.");
      }
      const version = currentVersion(db, item);
      if (!allowedActions(item.state, "user", db.user.role, version).includes(action)) {
        return apiError(409, "invalid_transition", "That action is not allowed in this state.");
      }
      const step = action === "produce" ? version && nextProductionStep(version) : action;
      const job = mockJob({
        projectId: item.projectId,
        conversationId: null,
        type: STEP_JOB_TYPES[step ?? "write_script"] ?? "content.write_script",
        maxAttempts: 3,
      });
      db.jobs.push(job);
      activeJobs(db).set(item.id, job.id);
      publish(db, { type: "job.updated", payload: { job } });
      if (db.simulateProducer && action === "produce") runProduction(db, item.id, job.id, through);
      else if (db.simulateProducer) runSingleStep(db, item.id, job.id, action);
      return HttpResponse.json(job, { status: 201 });
    }),
  ];
}

// Demo data -------------------------------------------------------------------

function daysFrom(now: number, days: number, hour = 9): string {
  const date = new Date(now + days * 24 * 60 * 60_000);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

/** Demo series and items for `pnpm --filter @loomcast/web dev:mock`. */
export function demoContent(
  projects: readonly Project[],
  userId: string,
  now: number,
): Pick<MockDb, "series" | "contentItems" | "contentVersions"> {
  const [rust, agents] = projects;
  const series: Series[] = [];
  const contentItems: ContentItem[] = [];
  const contentVersions: ContentVersion[] = [];
  if (!rust) return { series, contentItems, contentVersions };

  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const ownership = mockSeries({
    projectId: rust.id,
    name: "Ownership basics",
    createdAt: ago(9e3),
  });
  const errors = mockSeries({ projectId: rust.id, name: "Error handling", createdAt: ago(8e3) });
  series.push(ownership, errors);

  const add = (
    projectId: string,
    title: string,
    state: PipelineState,
    versionNo: number,
    updatedMinutesAgo: number,
    extra: Partial<ContentItem> = {},
  ) => {
    const { item, versions } = mockContentItem({
      projectId,
      title,
      state,
      versionNo,
      createdBy: userId,
      createdAt: ago(updatedMinutesAgo + 600),
      updatedAt: ago(updatedMinutesAgo),
      ...extra,
    });
    contentItems.push(item);
    contentVersions.push(...versions);
  };

  add(rust.id, "Why the borrow checker rejects this loop", "idea", 1, 8, {
    seriesId: ownership.id,
    pitch: "Show the error first, then the one-line fix.",
  });
  add(rust.id, "Clone is not a code smell (sometimes)", "idea", 1, 95, { seriesId: ownership.id });
  add(rust.id, "The question mark operator in 40 seconds", "script", 2, 22, {
    seriesId: errors.id,
    targetAt: daysFrom(now, 6),
  });
  add(rust.id, "Box, Rc and Arc on one screen", "storyboard", 3, 46, {
    seriesId: ownership.id,
    targetAt: daysFrom(now, 4, 17),
  });
  add(rust.id, "anyhow vs thiserror, picked in one rule", "voice", 4, 63, {
    seriesId: errors.id,
    targetAt: daysFrom(now, 3),
  });
  add(rust.id, "Lifetimes are just scopes with names", "render", 5, 4, {
    seriesId: ownership.id,
    targetAt: daysFrom(now, 2, 18),
  });
  add(rust.id, "Moves explained with a coffee cup", "review", 5, 30, {
    seriesId: ownership.id,
    targetAt: daysFrom(now, 1, 18),
  });
  add(rust.id, "unwrap is a promise you make to the reader", "review", 6, 140, {
    seriesId: errors.id,
    targetAt: daysFrom(now, 2, 9),
  });
  add(rust.id, "Result is just an enum", "approved", 5, 300, {
    seriesId: errors.id,
    targetAt: daysFrom(now, 5),
  });
  add(rust.id, "Slices without the confusion", "scheduled", 5, 900, {
    seriesId: ownership.id,
    targetAt: daysFrom(now, 1, 9),
  });
  add(rust.id, "String vs &str, finally", "published", 6, 3 * 24 * 60, {
    seriesId: ownership.id,
    targetAt: daysFrom(now, -3, 18),
  });
  add(rust.id, "Panics in production: a story", "archived", 2, 9 * 24 * 60, {
    seriesId: errors.id,
  });

  if (agents) {
    const patterns = mockSeries({
      projectId: agents.id,
      name: "Agent patterns",
      createdAt: ago(7e3),
    });
    series.push(patterns);
    add(agents.id, "One agent, one job: the small-team rule", "script", 2, 180, {
      seriesId: patterns.id,
      targetAt: daysFrom(now, 8),
    });
    add(agents.id, "Hand-offs that do not lose context", "idea", 1, 420, { seriesId: patterns.id });
    add(agents.id, "What to log when an agent fails", "published", 6, 6 * 24 * 60, {
      seriesId: patterns.id,
      targetAt: daysFrom(now, -6, 9),
    });
  }

  return { series, contentItems, contentVersions };
}
