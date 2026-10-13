import { randomBytes } from "node:crypto";
import { type BrowserContext, expect, type Locator, type Page, test } from "playwright/test";
import { e2eSettings } from "../support/env.ts";

/**
 * The M1 acceptance runbook, end to end: an owner made by the admin CLI signs in, creates a project,
 * queues a message with no studio agent, and signs out.
 *
 * The tests share one signed-in page and run in order. Navigation inside the app is done by
 * clicking, so the live event stream stays connected.
 */
test.describe.configure({ mode: "serial" });

const settings = e2eSettings();
const run = randomBytes(3).toString("hex");
const projectName = `Smoke project ${run}`;

let context: BrowserContext;
let page: Page;

function workspaceLink(name: RegExp) {
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

async function openProject(): Promise<void> {
  await workspaceLink(/^Projects/).click();
  await page.getByRole("link", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
}

async function sendMessage(text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message the studio agent" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("signs in as the owner created by the admin CLI", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Email").fill(settings.ownerEmail);
  await page.getByLabel("Password").fill(settings.ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText(settings.ownerEmail)).toBeVisible();
});

test("creates a project and lists it", async () => {
  await workspaceLink(/^Projects/).click();
  const dialog = await openDialog(
    page.getByRole("button", { name: "New project" }).first(),
    "New project",
  );
  await dialog.getByLabel("Name").fill(projectName);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole("link", { name: new RegExp(projectName) })).toBeVisible();
});

test("queues a message while no studio agent is paired", async () => {
  await openProject();
  await sendMessage("Draft a hook about bridges");

  await expect(page.getByText("Draft a hook about bridges")).toBeVisible();
  await expect(page.getByText("Waiting for studio agent (none paired)")).toBeVisible();
});

test("signs out", async () => {
  await page.getByRole("button", { name: new RegExp(settings.ownerName) }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.goto("/projects");
  await expect(page).toHaveURL(/\/login/);
});
