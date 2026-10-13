import { randomBytes } from "node:crypto";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  request,
  test,
} from "playwright/test";
import { e2eSettings, storageAvailable } from "../support/env.ts";
import {
  FakeStudioAgent,
  type PairedDevice,
  type ProductionJobType,
  pairDevice,
} from "../support/fake-agent.ts";

/**
 * The M3 acceptance runbook with a fake studio agent: a skill published over MCP is synced to the
 * studio, a series gets a new format with a voice, an idea in it is produced through review (the
 * agent answers script, storyboard, voice and render jobs with fixtures and uploads synthetic
 * media to object storage through presigned PUTs), the review screen shows every part, a request
 * for changes brings a revised version back to review, and approving it from the review queue
 * keeps every version.
 *
 * Uploads need object storage, so the spec runs only when the local store answers (see
 * `LOOMCAST_E2E_S3`). The tests share one signed-in page and run in order. The device this spec
 * pairs is revoked at the end, so the smoke that follows starts with no studio agent paired.
 */
test.describe.configure({ mode: "serial" });

const settings = e2eSettings();
const run = randomBytes(3).toString("hex");
const projectName = `Pipeline project ${run}`;
const seriesName = `Ownership basics ${run}`;
const ideaTitle = `Why the borrow checker rejects this loop ${run}`;
const ideaPitch = "Show the compiler error first, then the one-line fix.";
const deviceName = `E2E Production Studio ${run}`;
const skillName = `e2e-scriptwriting-${run}`;
const voiceId = `e2e-voice-${run}`;
const changeRequest = "Open on the compiler error message, then explain the fix.";

/** The production jobs of one pass from idea to review, in order. */
const FIRST_PASS: ProductionJobType[] = [
  "content.write_script",
  "content.storyboard",
  "content.voice",
  "content.render",
];
/** A revision: the revised script, then storyboard, voice and render again. */
const REVISION_PASS: ProductionJobType[] = [
  "content.revise",
  "content.storyboard",
  "content.voice",
  "content.render",
];
/** A production pass can take a while on a busy machine. */
const PRODUCTION_TIMEOUT = 60_000;

let context: BrowserContext;
let page: Page;
let owner: APIRequestContext;
let device: PairedDevice | null = null;
let agent: FakeStudioAgent | null = null;
let itemId = "";

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

function workspaceLink(name: RegExp): Locator {
  return page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name });
}

/**
 * Clicks `trigger` until the dialog `name` is open. The dev server reloads the page once if it
 * discovers a dependency late, which would otherwise swallow a single click.
 */
async function openDialog(trigger: Locator, name: string): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name });
  await expect(async () => {
    if (!(await dialog.isVisible())) {
      await trigger.click();
    }
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return dialog;
}

/** Opens one of the project's tabs, navigating by clicks so the live stream stays connected. */
async function openProjectTab(tab: "Content" | "Series"): Promise<void> {
  await workspaceLink(/^Projects/).click();
  await page.getByRole("link", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await page
    .getByRole("tablist", { name: "Project sections" })
    .getByRole("tab", { name: tab })
    .click();
}

/** Opens the item from the review queue, as a reviewer does. */
async function openFromReviewQueue(): Promise<void> {
  await workspaceLink(/^Review/).click();
  await expect(page).toHaveURL(/\/review/);
  const queue = page.getByRole("region", { name: "Review queue" });
  await queue.getByRole("link", { name: new RegExp(ideaTitle) }).click();
  await expect(page).toHaveURL(new RegExp(`/content/${itemId}`));
  await expect(page.getByRole("heading", { level: 1, name: ideaTitle })).toBeVisible();
}

/** A toast with `text`, among the app's notifications. */
function toast(text: string): Locator {
  return page
    .getByRole("region", { name: /^Notifications/ })
    .getByText(text, { exact: true })
    .first();
}

async function openItemTab(name: "Script" | "Storyboard" | "Voice" | "Video"): Promise<void> {
  await page
    .getByRole("tablist", { name: "Parts of the video" })
    .getByRole("tab", { name })
    .click();
}

/** The production job types the agent ran for the item, in order. */
function productionsOfItem(): ProductionJobType[] {
  return (agent?.productions ?? [])
    .filter((production) => production.payload.itemId === itemId)
    .map((production) => production.type);
}

/** Fails with the agent's own error when one of its production jobs failed. */
function expectNoProductionErrors(): void {
  const failed = (agent?.productions ?? []).filter((production) => production.error);
  expect(failed.map((production) => `${production.type}: ${production.error}`)).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  test.skip(
    !(await storageAvailable()),
    "Object storage is not reachable; start it with docker compose up -d s3 s3-init.",
  );
  context = await browser.newContext();
  page = await context.newPage();
  owner = await signedInApi();
  const created = await owner.post("/api/projects", { data: { name: projectName } });
  expect(created.status(), await created.text()).toBe(201);
});

test.afterAll(async () => {
  await agent?.close();
  if (device !== null) {
    // Leave no paired device behind for the specs that follow.
    const revoked = await owner.delete(`/api/devices/${device.deviceId}`);
    expect(revoked.ok(), await revoked.text()).toBe(true);
  }
  await owner?.dispose();
  await context?.close();
});

test("syncs a skill published over MCP to the studio agent", async () => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(settings.ownerEmail);
  await page.getByLabel("Password").fill(settings.ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(settings.ownerEmail)).toBeVisible();

  const codeResponse = await owner.post("/api/devices/pairing-codes");
  expect(codeResponse.status(), await codeResponse.text()).toBe(201);
  const { code } = (await codeResponse.json()) as { code: string };
  device = await pairDevice(settings.webUrl, code, deviceName);
  agent = new FakeStudioAgent({ serverUrl: settings.webUrl, token: device.token });
  await agent.connect();

  // Publishing needs a person's token; producer sessions (job tokens) may only pull.
  const tokenResponse = await owner.post("/api/tokens", {
    data: { name: `Skill publisher ${run}`, scopes: ["mcp:read", "mcp:write"] },
  });
  expect(tokenResponse.status(), await tokenResponse.text()).toBe(201);
  const { secret } = (await tokenResponse.json()) as { secret: string };
  const description = "Writes vertical explainer scripts as JSON.";
  const published = await owner.post("/mcp", {
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: "application/json, text/event-stream",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "skill.publish",
        arguments: {
          name: skillName,
          kind: "skill",
          files: [
            {
              path: "skill.json",
              content: JSON.stringify({ name: skillName, kind: "skill", description }),
            },
            { path: "SKILL.md", content: `# ${skillName}\n\nOpen on the hook in one line.\n` },
          ],
        },
      },
    },
  });
  expect(published.status(), await published.text()).toBe(200);
  const body = (await published.json()) as {
    result: { isError?: boolean; structuredContent: { version: number; created: boolean } };
  };
  expect(body.result.isError).toBeFalsy();
  expect(body.result.structuredContent).toMatchObject({ version: 1, created: true });

  // Publishing queues one skills.sync job, which the studio agent answers by pulling.
  await expect
    .poll(() => agent?.productions.find((production) => production.type === "skills.sync"))
    .toMatchObject({
      result: { synced: expect.arrayContaining([{ name: skillName, version: 1 }]) },
    });
  expectNoProductionErrors();
});

test("creates a series with a new format and gives it a voice", async () => {
  await openProjectTab("Series");
  await expect(page).toHaveURL(/\/series$/);
  const dialog = await openDialog(
    page.getByRole("button", { name: "New series" }).first(),
    "New series",
  );
  await dialog.getByLabel("Name").fill(seriesName);
  await dialog.getByRole("button", { name: "Create series" }).click();
  await expect(dialog).toBeHidden();

  // A new format opens in the editor; without a voice, production would stop before the voice.
  await expect(page).toHaveURL(/\/series\/[0-9a-f-]{36}\/format$/);
  await expect(page.getByRole("heading", { name: "Format rules" })).toBeVisible();
  await page.getByLabel("Shortest (seconds)").fill("20");
  await page.getByLabel("Longest (seconds)").fill("40");
  await page.getByLabel("Voice ID").fill(voiceId);
  await page.getByRole("button", { name: "Save version" }).click();
  await expect(toast("Saved as version 2")).toBeVisible();

  await page.getByRole("link", { name: seriesName }).first().click();
  await expect(page).toHaveURL(/\/series\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: seriesName })).toBeVisible();
});

test("adds an idea to the series and produces it through review", async () => {
  if (agent === null) throw new Error("no agent");
  const dialog = await openDialog(
    page.getByRole("button", { name: "New idea" }).first(),
    "New idea",
  );
  await dialog.getByLabel("Title").fill(ideaTitle);
  await dialog.getByLabel("Pitch").fill(ideaPitch);
  await dialog.getByRole("button", { name: "Add idea" }).click();
  await expect(dialog).toBeHidden();

  await openProjectTab("Content");
  const row = page.getByRole("row", { name: new RegExp(ideaTitle) });
  await expect(row).toContainText("Idea");
  await expect(row).toContainText(seriesName);
  const href = await row.getByRole("link", { name: ideaTitle }).getAttribute("href");
  itemId = href?.split("/").at(-1) ?? "";
  expect(itemId).toMatch(/^[0-9a-f-]{36}$/);

  await row.getByRole("button", { name: `Actions for ${ideaTitle}` }).click();
  await page.getByRole("menuitem", { name: "Produce through review" }).click();
  await expect(toast("Production started")).toBeVisible();

  // Autopilot runs script, storyboard, voice and render on the studio agent, then submits.
  await expect(row).toContainText("In review", { timeout: PRODUCTION_TIMEOUT });
  expectNoProductionErrors();
  expect(productionsOfItem()).toEqual(FIRST_PASS);

  // Every step carried the format snapshot with the voice set in the editor.
  const [script, , voice] = agent.productions.filter((p) => p.payload.itemId === itemId);
  expect(script?.payload.format).toMatchObject({ rules: { lengthSec: { min: 20, max: 40 } } });
  expect(voice?.payload.voice).toEqual({ voiceId });
  // The script step loaded the published skill.
  expect(agent.skillPulls.flat()).toContain(`${skillName}@1`);
});

test("shows the script, storyboard, voice and video for review", async () => {
  await openFromReviewQueue();
  const review = page.getByRole("region", { name: "Review" });
  await expect(review).toContainText("Deciding v5");

  // A rendered version opens on its video.
  await expect(page.getByLabel("Rendered video")).toBeAttached();
  await expect(page.getByText("1080 × 1920")).toBeVisible();

  await openItemTab("Script");
  const segments = page.getByRole("list", { name: "Segments" });
  await expect(segments).toContainText(`${ideaTitle}: here is the one idea that makes it click.`);
  await expect(segments.getByRole("listitem")).toHaveCount(4);

  await openItemTab("Storyboard");
  const frames = page.getByRole("list", { name: "Frames" });
  await expect(frames).toContainText("vox-explainer.t1.title");
  await expect(frames.getByRole("listitem")).toHaveCount(4);

  await openItemTab("Voice");
  const takes = page.getByRole("list", { name: "Voice takes" });
  await expect(takes.getByRole("listitem")).toHaveCount(1);
  await expect(takes.locator("audio")).toHaveCount(1);
});

test("requests changes and gets a revised version back in review", async () => {
  if (agent === null) throw new Error("no agent");
  const review = page.getByRole("region", { name: "Review" });
  await review.getByLabel("What should change?").fill(changeRequest);
  await expect(review.getByLabel("Ask the producer to revise")).toBeChecked();
  await review.getByRole("button", { name: "Request changes" }).click();
  await expect(toast("Changes requested")).toBeVisible();

  // The review queues content.revise with the comment, and autopilot brings it back to review.
  await expect(review).toContainText("Deciding v9", { timeout: PRODUCTION_TIMEOUT });
  expectNoProductionErrors();
  expect(productionsOfItem()).toEqual([...FIRST_PASS, ...REVISION_PASS]);
  const revise = agent.productions.find((production) => production.type === "content.revise");
  expect(revise?.payload.instructions).toBe(changeRequest);

  await openItemTab("Script");
  await expect(page.getByRole("list", { name: "Segments" })).toContainText(changeRequest);
  await openItemTab("Voice");
  // Both takes are kept.
  await expect(page.getByRole("list", { name: "Voice takes" }).getByRole("listitem")).toHaveCount(
    2,
  );
});

test("approves the revised version from the review queue and keeps every version", async () => {
  await openFromReviewQueue();
  const review = page.getByRole("region", { name: "Review" });
  await expect(review).toContainText("Deciding v9");
  await review.getByRole("button", { name: "Approve" }).click();
  await expect(toast("Approved")).toBeVisible();

  const decisions = page.getByRole("list", { name: "Earlier decisions" });
  await expect(decisions.getByRole("listitem")).toHaveCount(2);

  const detail = await owner.get(`/api/content/${itemId}`);
  expect(detail.status(), await detail.text()).toBe(200);
  const { item, versions, activeJob } = (await detail.json()) as {
    item: { state: string; versionNo: number };
    versions: { versionNo: number }[];
    activeJob: unknown;
  };
  expect(item).toMatchObject({ state: "approved", versionNo: 9 });
  expect(activeJob).toBeNull();
  expect(versions.map((version) => version.versionNo).sort((a, b) => a - b)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);

  // Nothing is left to review.
  await workspaceLink(/^Review/).click();
  await expect(
    page.getByRole("region", { name: "Review queue" }).getByRole("link", { name: ideaTitle }),
  ).toBeHidden();
  expect(agent?.invalidFrames).toEqual([]);
});
