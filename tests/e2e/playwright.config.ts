import { join } from "node:path";
import { defineConfig, devices } from "playwright/test";
import { apiEnvironment, e2eSettings, REPO_ROOT } from "./support/env.ts";

const settings = e2eSettings();
const CI = process.env.CI !== undefined && process.env.CI !== "";

/**
 * The smoke runs the real API (against a scratch database it creates and drops) and the Vite dev
 * server on free ports, then drives the web app in Chromium. A fake studio agent in the test
 * process answers chat jobs over the bridge.
 */
export default defineConfig({
  testDir: "./specs",
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  outputDir: "test-results",
  globalSetup: "./support/global-setup.ts",
  use: {
    baseURL: settings.webUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "api",
      command: "node --import tsx support/api-server.ts",
      cwd: import.meta.dirname,
      url: `${settings.apiUrl}/readyz`,
      env: { ...apiEnvironment(settings) },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    },
    {
      name: "web",
      command: `pnpm exec vite --host 127.0.0.1 --port ${settings.webPort} --strictPort`,
      cwd: join(REPO_ROOT, "apps/web"),
      url: settings.webUrl,
      env: { LOOMCAST_API_URL: settings.apiUrl },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
