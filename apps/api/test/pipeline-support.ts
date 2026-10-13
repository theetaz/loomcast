import { createHash, randomUUID } from "node:crypto";
import type {
  AssetKind,
  AssetStatus,
  LiveEvent,
  PipelineState,
  Script,
  Storyboard,
} from "@loomcast/contracts";
import { assets, contentItems, contentVersions, type Database, projects } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { ModuleDeps } from "../src/deps";
import type { BusEventOf, InternalEvent } from "../src/lib/bus";
import type { PipelineActor } from "../src/modules/content";
import { createTestApp, insertUser, login, send, type TestApp } from "./support";

/** A test app with a signed-in user, its module deps and every published event. */
export interface PipelineHarness {
  testDb: TestDb;
  db: Database;
  t: TestApp;
  deps: ModuleDeps;
  cookie: string;
  userId: string;
  /** Live events, in publish order. */
  live: LiveEvent[];
  /** Internal pipeline events, in publish order. */
  internal: InternalEvent[];
  close(): Promise<void>;
}

export async function createPipelineHarness(): Promise<PipelineHarness> {
  const testDb = await createTestDb();
  let deps: ModuleDeps | undefined;
  const t = createTestApp(testDb.db, {
    modules: [
      (app, moduleDeps) => {
        deps = moduleDeps;
        return app;
      },
    ],
  });
  if (deps === undefined) {
    throw new Error("module deps were not captured");
  }
  const live: LiveEvent[] = [];
  const internal: InternalEvent[] = [];
  t.bus.subscribeLive((event) => {
    live.push(event);
  });
  for (const type of ["content.item.state_changed", "format.updated", "series.updated"] as const) {
    t.bus.subscribe(type, (event: BusEventOf<typeof type>) => {
      internal.push(event);
    });
  }
  const user = await insertUser(testDb.db);
  const { cookie } = await login(t.app, user.email);
  return {
    testDb,
    db: testDb.db,
    t,
    deps,
    cookie,
    userId: user.id,
    live,
    internal,
    async close() {
      await t.deps.lifecycle.close();
      await testDb.drop();
    },
  };
}

/** A REST call as the harness user. */
export function call(h: PipelineHarness, method: string, path: string, body?: unknown) {
  return send(h.t.app, method, path, { cookie: h.cookie, body });
}

export function userOf(h: PipelineHarness): PipelineActor {
  return { kind: "user", id: h.userId, userId: h.userId };
}

export async function insertProject(
  h: PipelineHarness,
  status: "active" | "archived" = "active",
): Promise<string> {
  const [project] = await h.db
    .insert(projects)
    .values({
      slug: `pipeline-${randomUUID().slice(0, 8)}`,
      name: "Pipeline",
      status,
      archivedAt: status === "archived" ? new Date() : null,
      createdBy: h.userId,
    })
    .returning();
  if (project === undefined) {
    throw new Error("project was not inserted");
  }
  return project.id;
}

export function script(overrides: Partial<Script> = {}): Script {
  return {
    title: "Why Rust ownership matters",
    hook: "Your code has a memory bug you cannot see.",
    segments: [
      { id: "s1", text: "Every value has exactly one owner." },
      { id: "s2", text: "When the owner goes away, so does the value." },
    ],
    cta: "Follow for more.",
    caption: "Ownership in sixty seconds",
    hashtags: ["rust"],
    estimatedDurationMs: 30_000,
    ...overrides,
  };
}

export function storyboard(overrides: Partial<Storyboard> = {}): Storyboard {
  return {
    styleId: "vox-explainer",
    fps: 30,
    aspect: "9:16",
    frames: [
      { id: "f1", segmentId: "s1", startMs: 0, endMs: 4_000, cardId: "title-card", slots: {} },
      { id: "f2", segmentId: "s2", startMs: 4_000, endMs: 8_000, cardId: "quote", slots: {} },
    ],
    ...overrides,
  };
}

/** Inserts a stored file of an item, ready unless `status` says otherwise. */
export async function insertAsset(
  db: Pick<Database, "insert">,
  values: {
    projectId: string;
    itemId: string | null;
    kind: AssetKind;
    status?: AssetStatus;
    durationMs?: number;
  },
): Promise<string> {
  const sha256 = createHash("sha256").update(randomUUID()).digest("hex");
  const [row] = await db
    .insert(assets)
    .values({
      projectId: values.projectId,
      itemId: values.itemId,
      kind: values.kind,
      status: values.status ?? "ready",
      bucket: "loomcast-media",
      storageKey: `projects/${values.projectId}/${values.kind}/${sha256}`,
      filename: `${values.kind}.bin`,
      mime: values.kind === "poster" ? "image/jpeg" : "video/mp4",
      bytes: 1_024,
      sha256,
      durationMs: values.durationMs ?? null,
      finalizedAt: values.status === "pending" ? null : new Date(),
    })
    .returning({ id: assets.id });
  if (row === undefined) {
    throw new Error("asset was not inserted");
  }
  return row.id;
}

/** How far the current version of an inserted item has come. */
export type ArtifactLevel = "none" | "script" | "storyboard" | "voice" | "render";

const LEVELS: readonly ArtifactLevel[] = ["none", "script", "storyboard", "voice", "render"];

export interface InsertedItem {
  itemId: string;
  /** The current version. */
  versionId: string;
  voiceAssetId: string | null;
  renderAssetId: string | null;
  posterAssetId: string | null;
}

/**
 * Inserts an item straight into the database, in any state, with a current version carrying the
 * artifacts up to `level` (the first version is the bare idea). Tests use it to start from states
 * the API would take several steps to reach.
 */
export async function insertItem(
  h: PipelineHarness,
  values: {
    projectId: string;
    state?: PipelineState;
    level?: ArtifactLevel;
    seriesId?: string | null;
    targetAt?: Date | null;
    title?: string;
  },
): Promise<InsertedItem> {
  const itemId = randomUUID();
  const firstId = randomUUID();
  const level = LEVELS.indexOf(values.level ?? "none");
  const currentId = level === 0 ? firstId : randomUUID();
  return h.db.transaction(async (tx) => {
    await tx.insert(contentItems).values({
      id: itemId,
      projectId: values.projectId,
      seriesId: values.seriesId ?? null,
      title: values.title ?? "Item",
      state: values.state ?? "idea",
      currentVersionId: currentId,
      targetAt: values.targetAt ?? null,
      createdVia: "ui",
      createdBy: h.userId,
    });
    await tx
      .insert(contentVersions)
      .values({ id: firstId, itemId, versionNo: 1, stage: "idea", createdVia: "system" });
    const asset = (kind: AssetKind) =>
      insertAsset(tx, { projectId: values.projectId, itemId, kind, durationMs: 31_000 });
    const voiceAssetId = level >= 3 ? await asset("voice") : null;
    const renderAssetId = level >= 4 ? await asset("render") : null;
    const posterAssetId = level >= 4 ? await asset("poster") : null;
    if (level > 0) {
      await tx.insert(contentVersions).values({
        id: currentId,
        itemId,
        versionNo: 2,
        stage: values.state ?? "idea",
        parentVersionId: firstId,
        script: script(),
        storyboard: level >= 2 ? storyboard() : null,
        voiceAssetId,
        renderAssetId,
        posterAssetId,
        createdVia: "ui",
      });
    }
    return { itemId, versionId: currentId, voiceAssetId, renderAssetId, posterAssetId };
  });
}

export function eventsOf<T extends LiveEvent["type"]>(
  events: readonly LiveEvent[],
  type: T,
): Extract<LiveEvent, { type: T }>[] {
  return events.filter((event): event is Extract<LiveEvent, { type: T }> => event.type === type);
}

export function internalOf<T extends InternalEvent["type"]>(
  events: readonly InternalEvent[],
  type: T,
): Extract<InternalEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<InternalEvent, { type: T }> => event.type === type,
  );
}
