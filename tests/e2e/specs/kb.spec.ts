import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  request,
  test,
} from "playwright/test";
import { e2eSettings, REPO_ROOT } from "../support/env.ts";
import {
  type ChatTurn,
  callMcpTool,
  FakeStudioAgent,
  type PairedDevice,
  pairDevice,
} from "../support/fake-agent.ts";

/**
 * The M2 acceptance runbook: a brainstorm written in the web app is found with ⌘K, a producer
 * chat saves a brainstorm over MCP with its job token and it appears live, a reference with a
 * transcript is analyzed by the (fake) studio agent, the session-end hook files a session
 * summary, and a user invited over the API sets a password and signs in.
 *
 * The tests share one signed-in page and run in order. The device this spec pairs is revoked at
 * the end, so the smoke that follows starts with no studio agent paired.
 */
test.describe.configure({ mode: "serial" });

const settings = e2eSettings();
const run = randomBytes(3).toString("hex");
const projectName = `Knowledge project ${run}`;
const deviceName = `E2E KB Studio ${run}`;
const HOOK = join(REPO_ROOT, "apps/studio-agent/hooks/session-end.mjs");

let context: BrowserContext;
let page: Page;
let owner: APIRequestContext;
let project: { id: string; slug: string };
let device: PairedDevice | null = null;
let agent: FakeStudioAgent | null = null;

/** A credential generated for this run only. */
function generatedSecret(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * An API client signed in as `email`. Like the web app, it sends the app's origin and JSON on
 * every request, which the API requires of unsafe methods even without a body.
 */
async function signedInApi(email: string, secret: string): Promise<APIRequestContext> {
  const api = await request.newContext({
    baseURL: settings.webUrl,
    extraHTTPHeaders: { Origin: settings.webUrl, "Content-Type": "application/json" },
  });
  const response = await api.post("/api/auth/login", { data: { email, password: secret } });
  expect(response.status(), await response.text()).toBe(200);
  return api;
}

/** A one-shot latch the test opens to let the fake agent continue. */
function latch(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function signIn(target: Page, email: string, secret: string): Promise<void> {
  await target.goto("/login");
  await target.getByLabel("Email").fill(email);
  await target.getByLabel("Password").fill(secret);
  await target.getByRole("button", { name: "Sign in" }).click();
  await expect(target).not.toHaveURL(/\/login/);
  await expect(target.getByText(email)).toBeVisible();
}

/** Opens one of the project's tabs, navigating by clicks so the live stream stays connected. */
async function openProjectTab(tab: "Overview" | "Chat" | "Knowledge"): Promise<void> {
  const tabs = page.getByRole("tablist", { name: "Project sections" });
  if (!(await tabs.isVisible())) {
    await page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: /^Projects/ })
      .click();
    await page.getByRole("link", { name: new RegExp(projectName) }).click();
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  }
  if (tab === "Knowledge" && /\/kb\/.+/.test(new URL(page.url()).pathname)) {
    // On an entry the tab is already selected; its "Knowledge" link leads back to the list.
    await page.getByRole("link", { name: "Knowledge", exact: true }).first().click();
  } else {
    await tabs.getByRole("tab", { name: tab }).click();
  }
  if (tab === "Knowledge") {
    await expect(page).toHaveURL(/\/projects\/[^/]+\/kb/);
    await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
  } else if (tab === "Chat") {
    await expect(page.getByRole("textbox", { name: "Message the studio agent" })).toBeVisible();
  }
}

/** Starts a new entry of `kind` from the Knowledge tab's "New entry" menu. */
async function newEntry(kind: "Brainstorm" | "Reference"): Promise<void> {
  await openProjectTab("Knowledge");
  await page.getByRole("button", { name: "New entry" }).click();
  await page.getByRole("menuitem", { name: kind }).click();
  await expect(page).toHaveURL(/\/kb\/new/);
}

/** Opens the command palette with ⌘K (Ctrl+K off Apple devices). */
async function openPalette() {
  const dialog = page.getByRole("dialog", { name: "Search or jump to" });
  await expect(async () => {
    if (!(await dialog.isVisible())) {
      await page.keyboard.press("ControlOrMeta+k");
    }
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  return dialog;
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  owner = await signedInApi(settings.ownerEmail, settings.ownerPassword);
  const created = await owner.post("/api/projects", { data: { name: projectName } });
  expect(created.status(), await created.text()).toBe(201);
  project = (await created.json()) as { id: string; slug: string };
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

test("signs in and opens the project's knowledge base", async () => {
  await signIn(page, settings.ownerEmail, settings.ownerPassword);
  await openProjectTab("Knowledge");
  await expect(page.getByRole("link", { name: "New brainstorm" })).toBeVisible();
});

test("creates a brainstorm and finds it with the command palette", async () => {
  const title = `Kerfuffle hooks ${run}`;
  await newEntry("Brainstorm");
  const editor = page.getByRole("form", { name: "Brainstorm editor" });
  await editor.getByLabel("Title").fill(title);
  await editor
    .getByLabel("Text", { exact: true })
    .fill("Open on the **error**, then explain why it happened.");
  await editor.getByRole("button", { name: /Save brainstorm/ }).click();
  await expect(page).toHaveURL(/\/kb\/[0-9a-f-]{36}$/);
  const entryId = new URL(page.url()).pathname.split("/").at(-1) ?? "";

  // Leave the entry, then jump back to it from the palette's knowledge-base search.
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: /^Projects/ })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
  const palette = await openPalette();
  await palette.getByRole("combobox", { name: "Search or jump to" }).fill("kerfuffle");
  const hit = palette.getByRole("option", { name: new RegExp(title) });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText(projectName);
  await hit.click();
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/kb/${entryId}$`));
  await expect(page.getByLabel("Title")).toHaveValue(title);
});

test("files a brainstorm from a producer chat through MCP and shows it live", async () => {
  const title = `Caching hooks from chat ${run}`;
  const gate = latch();
  const turnStarted = latch();
  let saved: Record<string, unknown> | undefined;
  const onChat = async (turn: ChatTurn) => {
    turnStarted.open();
    await gate.promise;
    if (turn.credentials === undefined) throw new Error("the job came without MCP credentials");
    const result = await callMcpTool(settings.webUrl, turn.credentials, "kb.save_brainstorm", {
      projectId: turn.job.projectId,
      title,
      bodyMd: "- Open on a cache miss\n- Show the latency drop",
      sessionRef: turn.sessionId,
    });
    if (result.isError) throw new Error(`kb.save_brainstorm failed: ${JSON.stringify(result)}`);
    saved = result.structuredContent;
    turn.reply(`Saved the brainstorm "${title}".`);
  };

  const codeResponse = await owner.post("/api/devices/pairing-codes");
  expect(codeResponse.status(), await codeResponse.text()).toBe(201);
  const { code } = (await codeResponse.json()) as { code: string };
  device = await pairDevice(settings.webUrl, code, deviceName);
  agent = new FakeStudioAgent({ serverUrl: settings.webUrl, token: device.token, onChat });
  await agent.connect();

  await openProjectTab("Chat");
  await page
    .getByRole("textbox", { name: "Message the studio agent" })
    .fill("Brainstorm hooks about caching and save them");
  await page.getByRole("button", { name: "Send message" }).click();
  await turnStarted.promise;

  // Watch the Knowledge tab while the producer session writes.
  await openProjectTab("Knowledge");
  const row = page.getByRole("link", { name: new RegExp(title) });
  await expect(row).toBeHidden();
  gate.open();
  await expect(row).toBeVisible();
  expect(saved?.entryId).toEqual(expect.any(String));
  expect(agent.turns.at(-1)?.text).toBe("Brainstorm hooks about caching and save them");
  expect(agent.invalidFrames).toEqual([]);
});

test("analyzes a reference from its transcript with the studio agent", async () => {
  if (agent === null) throw new Error("no agent");
  const hookLine = "What happens when you type a URL and press enter?";
  await newEntry("Reference");
  const form = page.getByRole("form", { name: "Save a reference" });
  await form
    .getByLabel("Link to the video")
    .fill(`https://www.youtube.com/shorts/${randomBytes(6).toString("hex")}`);
  await form.getByLabel("Why you liked it").fill("The question lands before the answer.");
  await form
    .getByLabel("Transcript")
    .fill(`[00:00] ${hookLine}\n[00:03] First, the browser asks DNS for the address.`);
  await form.getByRole("button", { name: /Save reference/ }).click();
  await expect(page).toHaveURL(/\/kb\/[0-9a-f-]{36}$/);

  const analysis = page.getByRole("region", { name: "Analysis" });
  await expect(analysis).toContainText("Not analyzed yet");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();

  await expect(analysis).toContainText(hookLine);
  await expect(analysis).toContainText("Open on the question the viewer already has.");
  await expect(page.getByText("Analyzed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-analyze" })).toBeEnabled();
  expect(agent.analyses).toHaveLength(1);
  expect(agent.analyses[0]?.transcript).toContain(hookLine);
  expect(agent.analyses[0]?.likedReason).toBe("The question lands before the answer.");
});

test("files a session summary with the session-end hook", async () => {
  const tokenResponse = await owner.post("/api/tokens", {
    data: { name: `Session hook ${run}`, scopes: ["mcp:read", "mcp:write"] },
  });
  expect(tokenResponse.status(), await tokenResponse.text()).toBe(201);
  const { secret } = (await tokenResponse.json()) as { secret: string };

  const dir = mkdtempSync(join(tmpdir(), "loomcast-e2e-hook-"));
  try {
    const transcriptPath = join(dir, "session.jsonl");
    const lines = [
      {
        type: "user",
        timestamp: "2026-10-13T09:00:00.000Z",
        message: { role: "user", content: `Script the DNS explainer ${run}` },
      },
      {
        type: "assistant",
        timestamp: "2026-10-13T09:04:30.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "The script is in script.md." },
            { type: "tool_use", name: "Write", input: { file_path: join(dir, "script.md") } },
          ],
        },
      },
    ];
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    await openProjectTab("Knowledge");
    const row = page.getByRole("link", { name: new RegExp(`Script the DNS explainer ${run}`) });
    await expect(row).toBeHidden();

    const outcome = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [HOOK], {
          env: {
            PATH: process.env.PATH ?? "",
            LOOMCAST_SESSION_HOOK: "1",
            LOOMCAST_URL: settings.webUrl,
            LOOMCAST_MCP_TOKEN: secret,
            LOOMCAST_PROJECT_ID: project.id,
          },
          stdio: ["pipe", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stderr }));
        child.stdin.end(
          JSON.stringify({ session_id: `e2e-${run}`, transcript_path: transcriptPath, cwd: dir }),
        );
      },
    );
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toContain("saved session summary");

    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByText("The script is in script.md.")).toBeVisible();
    await expect(page.getByText("script.md", { exact: true })).toBeVisible();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invites a user over the API who sets a password and signs in", async ({ browser }) => {
  const email = `invitee-${run}@example.test`;
  const invited = await owner.post("/api/users/invitations", {
    data: { email, name: `Invitee ${run}`, role: "admin" },
  });
  expect(invited.status(), await invited.text()).toBe(201);
  const { setPasswordUrl } = (await invited.json()) as { setPasswordUrl: string };
  expect(setPasswordUrl).toMatch(/\/set-password#token=/);

  const inviteeContext = await browser.newContext();
  try {
    const invitee = await inviteeContext.newPage();
    await invitee.goto(setPasswordUrl);
    await expect(invitee.getByRole("heading", { name: "Join Loomcast" })).toBeVisible();
    // The token is taken out of the address bar before anything else happens.
    await expect(invitee).not.toHaveURL(/#token=/);
    await expect(invitee.getByLabel("Email")).toHaveValue(email);

    const chosen = generatedSecret();
    await invitee.getByLabel("New password").fill(chosen);
    await invitee.getByLabel("Confirm password").fill(chosen);
    await invitee.getByRole("button", { name: "Set password" }).click();
    await expect(invitee).toHaveURL(/\/login/);

    await signIn(invitee, email, chosen);

    // The link works once.
    await invitee.goto(setPasswordUrl);
    await expect(invitee.getByText("This link has expired or was already used")).toBeVisible();
  } finally {
    await inviteeContext.close();
  }
});
