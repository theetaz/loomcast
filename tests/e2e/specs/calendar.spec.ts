import { randomBytes } from "node:crypto";
import {
  type ApprovalsInbox,
  type CalendarResponse,
  type Channel,
  type ContentItem,
  DEFAULT_FORMAT_RULES,
  dryRunPermalink,
  type Format,
  type FormatRules,
  type Platform,
  type PublishAttempt,
  type Review,
  type ScheduledPost,
  type Series,
  toLocalDateTime,
  WEEKDAYS,
} from "@loomcast/contracts";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  request,
  test,
} from "playwright/test";
import { CADENCE_HORIZON_DAYS, e2eSettings, storageAvailable } from "../support/env.ts";
import {
  FakeStudioAgent,
  type PairedDevice,
  type ProductionJobType,
  pairDevice,
} from "../support/fake-agent.ts";

/**
 * The M4 acceptance runbook with a fake studio agent and dry-run channels: a series whose format
 * publishes automatically on a daily cadence fills the calendar 14 days ahead as soon as it is
 * linked to a channel; the slot inside the one-hour lead time is produced right away, approved by
 * the system and published by the dry-run publisher at its slot, which records a `dryrun://`
 * permalink and the exact requests a live run would send. A second series on the same format
 * publishes to a channel that requires approval: its video waits in the approvals inbox until it
 * is approved there, then publishes at the same slot. A planned post is dragged to the next day on
 * the month view of the calendar.
 *
 * The slot is a few minutes ahead, in a time zone other than the browser's, so the run waits for
 * it once; the API runs its scheduler every 500 ms (`SCHEDULER_TICK_MS`). Production uploads media,
 * so the spec runs only with object storage, like the pipeline spec. At the end both series are
 * paused (which retires their remaining ideas) and the device is revoked, so the specs that follow
 * start with no studio agent paired and no planned work.
 */
test.describe.configure({ mode: "serial" });

const settings = e2eSettings();
const run = randomBytes(3).toString("hex");
const workspaceName = `Calendar workspace ${run}`;
const formatName = `Daily explainer ${run}`;
const autoSeriesName = `Daily shorts ${run}`;
const autoChannelName = `E2E Reels ${run}`;
const approvalSeriesName = `Reviewed shorts ${run}`;
const approvalChannelName = `E2E Threads ${run}`;
const deviceName = `E2E Calendar Studio ${run}`;
const voiceId = `e2e-voice-${run}`;
const hashtag = `loomcast${run}`;

/** The cadence's time zone: not the browser's (UTC), and without daylight saving. */
const CADENCE_TZ = "Asia/Colombo";
/** The browser's time zone, so calendar days are predictable. */
const BROWSER_TZ = "UTC";
/** How far ahead the first slot is: production has to finish before it. */
const SLOT_LEAD_MS = 4 * 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The production jobs of one pass from idea to review, in order. */
const FIRST_PASS: ProductionJobType[] = [
  "content.write_script",
  "content.storyboard",
  "content.voice",
  "content.render",
];
/** A production pass can take a while on a busy machine. */
const PRODUCTION_TIMEOUT = 120_000;

let context: BrowserContext;
let page: Page;
let owner: APIRequestContext;
let device: PairedDevice | null = null;
let agent: FakeStudioAgent | null = null;
let workspaceId = "";
let workspaceSlug = "";
let autoSeries: Series;
let autoChannel: Channel;
let approvalSeries: Series;
let approvalChannel: Channel;
/** The first slot: the next whole minute at least `SLOT_LEAD_MS` ahead. */
let slotAt: Date;
/** The post of the first slot on the auto series' channel. */
let firstPost: ScheduledPost;
/** The post of the first slot on the channel that requires approval. */
let approvalPost: ScheduledPost;

/**
 * An API client signed in as the owner. Like the web app, it sends the app's origin and JSON on
 * every request, which the API requires of unsafe methods even without a body.
 */
async function signedInApi(): Promise<APIRequestContext> {
  const api = await request.newContext({
    baseURL: settings.webUrl,
    extraHTTPHeaders: { Origin: settings.webUrl, "Content-Type": "application/json" },
  });
  const response = await api.post("/api/auth/login", {
    data: { email: settings.ownerEmail, password: settings.ownerPassword },
  });
  expect(response.status(), await response.text()).toBe(200);
  return api;
}

/** Calls the API as the owner and returns the JSON body, failing on an unexpected status. */
async function call<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  options: { data?: unknown; status?: number } = {},
): Promise<T> {
  const response = await owner.fetch(path, {
    method,
    ...(options.data === undefined ? {} : { data: options.data }),
  });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(
    options.status ?? (method === "GET" ? 200 : method === "POST" ? 201 : 200),
  );
  return (await response.json()) as T;
}

/** The series' posts from an hour ago to past the planning horizon, in time order. */
async function postsOf(seriesId: string): Promise<ScheduledPost[]> {
  const from = new Date(Date.now() - 60 * MINUTE_MS).toISOString();
  const to = new Date(Date.now() + (CADENCE_HORIZON_DAYS + 1) * DAY_MS).toISOString();
  const query = new URLSearchParams({ from, to, workspaceId, seriesIds: seriesId });
  const { posts } = await call<CalendarResponse>("GET", `/api/calendar?${query}`);
  return posts;
}

async function postOf(post: ScheduledPost): Promise<ScheduledPost> {
  const posts = await postsOf(post.seriesId ?? "");
  const found = posts.find((candidate) => candidate.id === post.id);
  if (found === undefined) throw new Error(`post ${post.id} is not on the calendar`);
  return found;
}

async function itemOf(itemId: string): Promise<ContentItem> {
  const { item } = await call<{ item: ContentItem }>("GET", `/api/content/${itemId}`);
  return item;
}

async function reviewsOf(itemId: string): Promise<Review[]> {
  const { items } = await call<{ items: Review[] }>("GET", `/api/content/${itemId}/reviews`);
  return items;
}

/** A planning channel: disconnected, so it can only dry-run. */
async function createChannel(
  platform: Platform,
  displayName: string,
  requiresApproval: boolean,
): Promise<Channel> {
  const channel = await call<Channel>("POST", `/api/workspaces/${workspaceId}/channels`, {
    data: { platform, displayName, requiresApproval },
  });
  expect(channel).toMatchObject({ dryRun: true, connected: false, requiresApproval });
  return channel;
}

/** The title the planner gives the item of a slot: the series and the slot's local date. */
function plannedTitle(seriesName: string, at: Date): string {
  return `${seriesName} · ${toLocalDateTime(at, CADENCE_TZ).date}`;
}

/** The `YYYY-MM-DD` day of an instant in the browser's time zone, `days` later. */
function browserDay(at: string | Date, days = 0): string {
  return toLocalDateTime(new Date(new Date(at).getTime() + days * DAY_MS), BROWSER_TZ).date;
}

/** The production job types the agent ran for the item, in order. */
function productionsOfItem(itemId: string): ProductionJobType[] {
  return (agent?.productions ?? [])
    .filter((production) => production.payload.itemId === itemId)
    .map((production) => production.type);
}

/** Fails with the agent's own error when one of its production jobs failed. */
function expectNoProductionErrors(): void {
  const failed = (agent?.productions ?? []).filter((production) => production.error);
  expect(failed.map((production) => `${production.type}: ${production.error}`)).toEqual([]);
}

/** The chip of a post on the calendar board. */
function chipOf(post: ScheduledPost, within: Page | Locator = page): Locator {
  return within.locator(`[data-post-chip="${post.id}"]`);
}

/** Checks the post's dry-run publish: its permalink and the recorded requests of the attempt. */
async function expectDryRunPublished(post: ScheduledPost, platform: Platform): Promise<void> {
  const published = await postOf(post);
  const permalink = dryRunPermalink(platform, post.id);
  expect(published).toMatchObject({
    status: "published",
    dryRun: true,
    platform,
    permalink,
    attempts: 1,
    lastError: null,
  });
  expect(Date.parse(published.publishedAt ?? "")).toBeGreaterThanOrEqual(slotAt.getTime());

  const { items: attempts } = await call<{ items: PublishAttempt[] }>(
    "GET",
    `/api/scheduled-posts/${post.id}/attempts`,
  );
  expect(attempts).toHaveLength(1);
  const [attempt] = attempts;
  expect(attempt).toMatchObject({
    attempt: 1,
    adapter: platform,
    dryRun: true,
    error: null,
    response: { dryRun: true, permalink },
  });
  // The recorded plan is what the live adapter would send: the platform's steps, the video at a
  // placeholder URL that never resolves, the caption with the format's hashtag, no credentials.
  const plan = attempt?.request as {
    platform: Platform;
    steps: { step: string; headers?: Record<string, string>; body?: Record<string, unknown> }[];
  };
  expect(plan.platform).toBe(platform);
  expect(plan.steps.length).toBeGreaterThan(0);
  const recorded = JSON.stringify(plan);
  expect(recorded).toContain(`https://dry-run.invalid/p/${post.id}/`);
  expect(recorded).toContain(`#${hashtag}`);
  for (const step of plan.steps) {
    for (const [name, value] of Object.entries(step.headers ?? {})) {
      if (name.toLowerCase() === "authorization") expect(value).toContain("[redacted]");
    }
  }
}

test.beforeAll(async ({ browser }) => {
  test.skip(
    !(await storageAvailable()),
    "Object storage is not reachable; start it with docker compose up -d s3 s3-init.",
  );
  context = await browser.newContext({ timezoneId: BROWSER_TZ });
  page = await context.newPage();
  owner = await signedInApi();

  const workspace = await call<{ id: string; slug: string }>("POST", "/api/workspaces", {
    data: { name: workspaceName },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;

  const codeResponse = await owner.post("/api/devices/pairing-codes");
  expect(codeResponse.status(), await codeResponse.text()).toBe(201);
  const { code } = (await codeResponse.json()) as { code: string };
  device = await pairDevice(settings.webUrl, code, deviceName);
  agent = new FakeStudioAgent({ serverUrl: settings.webUrl, token: device.token });
  await agent.connect();

  // Every day at one local time a few minutes from now, produced an hour ahead, published
  // without waiting for a person.
  slotAt = new Date(Math.ceil((Date.now() + SLOT_LEAD_MS) / MINUTE_MS) * MINUTE_MS);
  const rules: FormatRules = {
    ...structuredClone(DEFAULT_FORMAT_RULES),
    voiceId,
    cadence: {
      days: [...WEEKDAYS],
      slots: [toLocalDateTime(slotAt, CADENCE_TZ).time],
      tz: CADENCE_TZ,
      leadTimeHours: 1,
    },
    publishMode: "auto",
    caption: { hashtags: [hashtag] },
  };
  const format = await call<Format>("POST", `/api/workspaces/${workspaceId}/formats`, {
    data: { name: formatName, rules },
  });
  autoSeries = await call<Series>("POST", `/api/workspaces/${workspaceId}/series`, {
    data: { name: autoSeriesName, formatId: format.id },
  });
  autoChannel = await createChannel("instagram", autoChannelName, false);

  // The same format on a channel that requires approval: its posts wait for a person.
  approvalSeries = await call<Series>("POST", `/api/workspaces/${workspaceId}/series`, {
    data: { name: approvalSeriesName, formatId: format.id },
  });
  approvalChannel = await createChannel("threads", approvalChannelName, true);
  await call("PUT", `/api/series/${approvalSeries.id}/channels`, {
    data: { channels: [{ channelId: approvalChannel.id, enabled: true }] },
  });
});

test.afterAll(async () => {
  // Pausing retires the series' remaining ideas and cancels their posts.
  for (const series of [autoSeries, approvalSeries]) {
    if (series !== undefined) {
      await call<Series>("POST", `/api/series/${series.id}/pause`, { status: 200 });
    }
  }
  await agent?.close();
  if (device !== null) {
    // Leave no paired device behind for the specs that follow.
    const revoked = await owner.delete(`/api/devices/${device.deviceId}`);
    expect(revoked.ok(), await revoked.text()).toBe(true);
  }
  await owner?.dispose();
  await context?.close();
});

test("fills the calendar 14 days ahead once the series is linked to a dry-run channel", async () => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(settings.ownerEmail);
  await page.getByLabel("Password").fill(settings.ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(settings.ownerEmail)).toBeVisible();

  // The series page shows the cadence of its format and its next slot.
  await page.goto(`/w/${workspaceSlug}/series/${autoSeries.id}`);
  await expect(page.getByRole("heading", { name: autoSeriesName })).toBeVisible();
  await expect(page.getByText("Publish automatically")).toBeVisible();
  await expect(page.getByText("1 h before each slot")).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Next slots" }).locator("time").first(),
  ).toHaveAttribute("datetime", slotAt.toISOString());

  // Linking the channel plans the series.
  const channels = page.getByRole("list", { name: `Channels of ${autoSeriesName}` });
  await expect(channels).toContainText("dry run");
  const link = channels.getByRole("switch", {
    name: `Publish ${autoSeriesName} to ${autoChannelName} (Instagram)`,
  });
  await link.click();
  await expect(link).toBeChecked();

  // One slot a day for 14 days, each an idea with a planned dry-run post that publishes on its
  // own, at the cadence's local time in its own zone.
  await expect.poll(async () => (await postsOf(autoSeries.id)).length).toBe(CADENCE_HORIZON_DAYS);
  const posts = await postsOf(autoSeries.id);
  expect(posts.map((post) => post.scheduledAt)).toEqual(
    posts.map((_, day) => new Date(slotAt.getTime() + day * DAY_MS).toISOString()),
  );
  for (const [day, post] of posts.entries()) {
    expect(post).toMatchObject({
      channelId: autoChannel.id,
      platform: "instagram",
      dryRun: true,
      publishMode: "auto",
      item: { title: plannedTitle(autoSeriesName, new Date(post.scheduledAt)) },
    });
    if (day > 0) expect(post).toMatchObject({ status: "planned", versionId: null });
  }
  firstPost = posts[0] as ScheduledPost;

  // The workspace's calendar shows the first post on the day it falls on in the browser's time
  // zone (`zone=local`: the browser's clock rather than the workspace's).
  await page.goto(
    `/w/${workspaceSlug}/calendar?zone=local&series=${autoSeries.id}&date=${browserDay(slotAt)}`,
  );
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(chipOf(firstPost)).toBeVisible();
  await expect(chipOf(firstPost)).toHaveAccessibleName(
    new RegExp(`^${plannedTitle(autoSeriesName, slotAt)}\\. ${autoChannelName} \\(Instagram\\)`),
  );
});

test("produces the first slot ahead of time and approves it automatically", async () => {
  const itemId = firstPost.itemId;
  // Inside the lead time production starts at once; review approves on the user's behalf and
  // the item is scheduled with its post queued on the approved version.
  await expect
    .poll(async () => (await itemOf(itemId)).state, { timeout: PRODUCTION_TIMEOUT })
    .toBe("scheduled");
  expectNoProductionErrors();
  expect(productionsOfItem(itemId)).toEqual(FIRST_PASS);

  const item = await itemOf(itemId);
  const [review] = await reviewsOf(itemId);
  expect(review).toMatchObject({
    decision: "approve",
    actorKind: "system",
    versionId: item.currentVersionId,
  });
  await expect.poll(async () => (await postOf(firstPost)).status).toBe("queued");
  expect((await postOf(firstPost)).versionId).toBe(item.currentVersionId);

  // Slots outside the lead time wait: nothing else was produced.
  const later = (await postsOf(autoSeries.id)).slice(1);
  for (const post of later) expect(productionsOfItem(post.itemId)).toEqual([]);
});

test("holds a video for a channel that requires approval until it is approved in the inbox", async () => {
  // The channel's approval overrides the format's automatic publishing.
  await expect
    .poll(async () => (await postsOf(approvalSeries.id)).length)
    .toBe(CADENCE_HORIZON_DAYS);
  approvalPost = (await postsOf(approvalSeries.id))[0] as ScheduledPost;
  expect(approvalPost).toMatchObject({
    channelId: approvalChannel.id,
    platform: "threads",
    scheduledAt: slotAt.toISOString(),
    dryRun: true,
    publishMode: "approval",
  });
  const itemId = approvalPost.itemId;
  const title = plannedTitle(approvalSeriesName, slotAt);

  // Produced ahead of the slot like any other, it stops in review with its post still planned.
  await expect
    .poll(async () => (await itemOf(itemId)).state, { timeout: PRODUCTION_TIMEOUT })
    .toBe("review");
  expectNoProductionErrors();
  expect(productionsOfItem(itemId)).toEqual(FIRST_PASS);
  const inbox = await call<ApprovalsInbox>("GET", `/api/approvals?workspaceId=${workspaceId}`);
  expect(inbox.items.find((entry) => entry.item.id === itemId)).toMatchObject({
    deadlineAt: slotAt.toISOString(),
    posts: [{ id: approvalPost.id, status: "planned", versionId: null }],
  });
  expect(await reviewsOf(itemId)).toEqual([]);

  // The sidebar works in the workspace whose calendar is open.
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Approvals", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceSlug}/approvals$`));
  const waiting = page.getByRole("list", { name: "Videos waiting for approval" });
  const row = waiting.getByRole("listitem", { name: title });
  await expect(row).toContainText(approvalSeriesName);
  await row.getByRole("button", { name: `Approve ${title}` }).click();
  await expect(row).toBeHidden();

  // The person's approval queues the post on the approved version and schedules the item.
  await expect.poll(async () => (await itemOf(itemId)).state).toBe("scheduled");
  const item = await itemOf(itemId);
  const [review] = await reviewsOf(itemId);
  expect(review).toMatchObject({
    decision: "approve",
    actorKind: "user",
    versionId: item.currentVersionId,
  });
  expect(await postOf(approvalPost)).toMatchObject({
    status: "queued",
    versionId: item.currentVersionId,
  });
});

test("moves a planned post to the next day by dragging it on the calendar", async () => {
  const post = (await postsOf(autoSeries.id))[2] as ScheduledPost;
  expect(post).toMatchObject({ status: "planned", channelId: autoChannel.id });
  const movedTo = new Date(Date.parse(post.scheduledAt) + DAY_MS).toISOString();

  await page.goto(
    `/w/${workspaceSlug}/calendar?view=month&zone=local&series=${autoSeries.id}&date=${browserDay(post.scheduledAt)}`,
  );
  const chip = chipOf(post);
  await expect(chip).toBeVisible();
  const target = page.locator(`[data-cell="day:${browserDay(post.scheduledAt, 1)}"]`);

  // A pointer drag: press, move past the activation distance, cross to the next day and drop.
  // Hovering scrolls the chip into view, so the next day's box is measured after it.
  await chip.hover();
  const box = await target.boundingBox();
  if (box === null) throw new Error("the next day is not on the board");
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await expect(target).toHaveAttribute("data-over", "true");
  await page.mouse.up();

  // The post lands at once at the same time of day, and the move is stored.
  await expect(chipOf(post, target)).toBeVisible();
  await expect.poll(async () => (await postOf(post)).scheduledAt).toBe(movedTo);
  expect(await postOf(post)).toMatchObject({ status: "planned", versionId: null });
  await page.reload();
  await expect(chipOf(post, target)).toBeVisible();

  // The cadence slot it left is open again.
  const query = new URLSearchParams({
    from: post.scheduledAt,
    to: new Date(Date.parse(post.scheduledAt) + MINUTE_MS).toISOString(),
    workspaceId,
    seriesIds: autoSeries.id,
  });
  const { slots } = await call<CalendarResponse>("GET", `/api/calendar?${query}`);
  expect(slots).toEqual([
    { at: post.scheduledAt, seriesId: autoSeries.id, channelId: autoChannel.id },
  ]);
});

test("publishes both posts in dry-run at the slot and records the exact payload", async () => {
  const wait = Math.max(0, slotAt.getTime() - Date.now()) + 90_000;
  test.setTimeout(wait + 60_000);
  await page.goto(
    `/w/${workspaceSlug}/calendar?zone=local&series=${autoSeries.id}&date=${browserDay(slotAt)}`,
  );
  await expect(chipOf(firstPost)).toHaveAttribute("data-status", "queued");

  await expect
    .poll(async () => (await postOf(firstPost)).status, { timeout: wait })
    .toBe("published");
  await expectDryRunPublished(firstPost, "instagram");
  expect((await itemOf(firstPost.itemId)).state).toBe("published");

  // The approved video publishes at the same slot.
  await expect
    .poll(async () => (await postOf(approvalPost)).status, { timeout: 60_000 })
    .toBe("published");
  await expectDryRunPublished(approvalPost, "threads");
  expect((await itemOf(approvalPost.itemId)).state).toBe("published");

  // The open calendar shows it published, live.
  await expect(chipOf(firstPost)).toHaveAttribute("data-status", "published");

  // Nothing ended in the dead-letter list.
  const dead = await call<{ items: unknown[] }>("GET", "/api/scheduler/tasks?status=dead");
  expect(dead.items).toEqual([]);
  expect(agent?.invalidFrames).toEqual([]);
});
