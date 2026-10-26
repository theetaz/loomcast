/**
 * Takes the screenshots of the in-app guide (`docs/guide/images`).
 *
 * It starts the web app in mock mode, where the API is simulated in the browser with made-up
 * demo data, so no screenshot can show a real account, token, address or channel. Run it after a
 * change to a screen the guide shows:
 *
 *   pnpm --filter @loomcast/e2e guide:screenshots           # every screenshot
 *   pnpm --filter @loomcast/e2e guide:screenshots devices   # only names containing "devices"
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { REPO_ROOT } from "../support/env.ts";

const PORT = Number(process.env.GUIDE_SCREENSHOT_PORT ?? 5199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = join(REPO_ROOT, "docs", "guide", "images");
const START_TIMEOUT_MS = 60_000;

interface Shot {
  /** File name without `.png`. */
  name: string;
  /** Page to open. */
  path: string;
  /** Steps after the page loaded, such as opening a detail page or a dialog. */
  steps?: (page: Page) => Promise<void>;
  /** Taller than the viewport: the whole page. */
  fullPage?: boolean;
}

/**
 * Clicks the first visible link whose address matches `pattern`. It navigates within the app: a
 * page load would reseed the demo data with new ids.
 */
async function openFirst(page: Page, pattern: RegExp) {
  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  const index = hrefs.findIndex((candidate) =>
    pattern.test(new URL(candidate, BASE_URL).pathname.replace(/(.)\/$/, "$1")),
  );
  if (index === -1) throw new Error(`no link matches ${pattern}`);
  await page.locator("a[href]").nth(index).click();
  await settle(page);
}

/** Clicks the first link whose accessible name matches `name`. */
async function openNamed(page: Page, name: RegExp) {
  await page.getByRole("link", { name }).first().click();
  await settle(page);
}

async function clickButton(page: Page, name: string | RegExp) {
  await page.getByRole("button", { name }).first().click();
  await page.getByRole("dialog").waitFor();
  await settle(page);
}

/** Opens a dropdown menu from the button `name`. */
async function openMenu(page: Page, name: string | RegExp) {
  await page.getByRole("button", { name }).first().click();
  await page.getByRole("menu").waitFor();
  await settle(page);
}

/** The first demo workspace. Slugs, unlike ids, stay the same when a page load reseeds the data. */
const WORKSPACE = "/w/rust-in-60-seconds";

const SHOTS: readonly Shot[] = [
  { name: "login", path: "/login" },
  // `/` opens the remembered workspace, else the most recently updated one.
  { name: "home", path: "/" },
  { name: "workspaces", path: "/workspaces" },
  {
    name: "workspace-switcher",
    path: WORKSPACE,
    steps: (page) => openMenu(page, /Switch workspace/),
  },
  { name: "workspace-overview", path: WORKSPACE },
  { name: "workspace-chat", path: `${WORKSPACE}/chat` },
  { name: "calendar", path: `${WORKSPACE}/calendar` },
  { name: "library", path: `${WORKSPACE}/library` },
  { name: "review", path: `${WORKSPACE}/review` },
  {
    name: "content-item",
    path: `${WORKSPACE}/review`,
    steps: (page) => openFirst(page, /^\/w\/[^/]+\/content\/[^/]+$/),
  },
  { name: "approvals", path: `${WORKSPACE}/approvals` },
  { name: "analytics", path: `${WORKSPACE}/analytics` },
  { name: "series", path: `${WORKSPACE}/series` },
  {
    name: "series-detail",
    path: `${WORKSPACE}/series`,
    steps: (page) => openFirst(page, /\/series\/[^/]+$/),
  },
  {
    name: "series-format",
    path: `${WORKSPACE}/series`,
    steps: async (page) => {
      await openFirst(page, /\/series\/[^/]+$/);
      await openFirst(page, /\/format$/);
    },
  },
  { name: "knowledge-base", path: `${WORKSPACE}/kb` },
  {
    name: "knowledge-base-entry",
    path: `${WORKSPACE}/kb`,
    steps: (page) => openFirst(page, /\/kb\/(?!new)[^/]+$/),
  },
  { name: "competitors", path: `${WORKSPACE}/competitors` },
  {
    name: "competitor",
    path: `${WORKSPACE}/competitors`,
    steps: (page) => openNamed(page, /fastrust/),
  },
  {
    name: "competitor-scan-dialog",
    path: `${WORKSPACE}/competitors`,
    steps: async (page) => {
      await openNamed(page, /fastrust/);
      await clickButton(page, /scan/i);
    },
  },
  {
    name: "competitor-scan",
    path: `${WORKSPACE}/competitors`,
    steps: async (page) => {
      await openNamed(page, /fastrust/);
      await openFirst(page, /\/scans\/[^/]+$/);
    },
  },
  { name: "workspace-settings-general", path: `${WORKSPACE}/settings` },
  { name: "workspace-settings-channels", path: `${WORKSPACE}/settings/channels` },
  { name: "workspace-settings-api-clients", path: `${WORKSPACE}/settings/api-clients` },
  {
    // In mock mode a sign-in returns at once, with demo accounts to choose from.
    name: "channels-connect",
    path: `${WORKSPACE}/settings/channels`,
    steps: async (page) => {
      await openMenu(page, /^Connect/);
      await page.getByRole("menuitem", { name: /Threads/ }).click();
      await page.waitForURL(/\/channels\/connect/);
      await settle(page);
    },
  },
  { name: "guide", path: "/guide/studio-agent" },
  { name: "settings-devices", path: "/settings/devices" },
  {
    name: "settings-devices-pair",
    path: "/settings/devices",
    steps: (page) => clickButton(page, /pair a device/i),
  },
  { name: "settings-tokens", path: "/settings/tokens" },
  {
    name: "settings-tokens-new",
    path: "/settings/tokens",
    steps: (page) => clickButton(page, /new token/i),
  },
  { name: "settings-members", path: "/settings/members" },
  {
    name: "settings-members-invite",
    path: "/settings/members",
    steps: (page) => clickButton(page, /invite/i),
  },
  { name: "settings-scheduler", path: "/settings/scheduler" },
  {
    name: "user-menu",
    path: WORKSPACE,
    steps: (page) => openMenu(page, /owner@loomcast\.test/),
  },
];

/** Waits for the network to go quiet and for animations to end. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

function startMockServer(): ChildProcess {
  const webDir = join(REPO_ROOT, "apps", "web");
  return spawn(
    join(webDir, "node_modules", ".bin", "vite"),
    ["--mode", "mock", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
    { cwd: webDir, stdio: ["ignore", "inherit", "inherit"], detached: true },
  );
}

async function waitForServer() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the mock web app did not start on ${BASE_URL}`);
}

async function main() {
  const filter = process.argv[2];
  const shots = filter ? SHOTS.filter((shot) => shot.name.includes(filter)) : SHOTS;
  mkdirSync(OUT_DIR, { recursive: true });

  const server = startMockServer();
  const stop = () => {
    if (server.pid !== undefined) process.kill(-server.pid, "SIGTERM");
  };
  try {
    await waitForServer();
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    // The mock API keeps its session in sessionStorage; every page but the login starts signed in.
    await context.addInitScript(() => {
      if (location.pathname !== "/login") sessionStorage.setItem("loomcast-mock-session", "1");
    });
    const page = await context.newPage();
    const failed: string[] = [];
    for (const shot of shots) {
      try {
        await page.goto(new URL(shot.path, BASE_URL).toString());
        await settle(page);
        await shot.steps?.(page);
        await page.screenshot({
          path: join(OUT_DIR, `${shot.name}.png`),
          fullPage: shot.fullPage ?? false,
        });
        console.log(`saved ${shot.name}.png`);
      } catch (error) {
        failed.push(shot.name);
        console.error(`failed ${shot.name}: ${(error as Error).message}`);
      }
    }
    await browser.close();
    if (failed.length > 0) {
      console.error(`${failed.length} screenshot(s) failed: ${failed.join(", ")}`);
      process.exitCode = 1;
    }
  } finally {
    stop();
  }
}

await main();
