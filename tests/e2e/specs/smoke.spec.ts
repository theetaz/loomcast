import { randomBytes } from "node:crypto";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "playwright/test";
import { e2eSettings } from "../support/env.ts";
import { type ChatTurn, echoHandler, FakeStudioAgent, pairDevice } from "../support/fake-agent.ts";

/**
 * The M1 acceptance runbook, end to end: an owner made by the admin CLI signs in, creates a workspace,
 * queues a message with no studio agent, pairs a fake studio agent through the UI's pairing code,
 * watches the reply stream in, sees the device go online and offline, calls the MCP server with an
 * access token from Settings, and signs out.
 *
 * The tests share one signed-in page and run in order. Navigation inside the app is done by
 * clicking, so the live event stream stays connected and no streamed text is missed.
 */
test.describe.configure({ mode: "serial" });

const settings = e2eSettings();
const run = randomBytes(3).toString("hex");
const workspaceName = `Smoke workspace ${run}`;
const mcpWorkspaceName = `Created over MCP ${run}`;
const deviceName = `E2E Studio ${run}`;

let context: BrowserContext;
let page: Page;
let agent: FakeStudioAgent | null = null;

/** A one-shot latch the test opens to let the fake agent continue. */
function latch(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A link in the sidebar, such as a page of the open workspace or Account settings. */
function sidebarLink(name: string) {
  return page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name, exact: true });
}

/** Opens the list of every workspace from the workspace switcher in the sidebar header. */
async function openAllWorkspaces(): Promise<void> {
  await page.getByRole("button", { name: /Switch workspace|Choose a workspace/ }).click();
  await page.getByRole("menuitem", { name: "All workspaces" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
}

/** Makes `name` the open workspace with the switcher, unless the sidebar already works in it. */
async function switchToWorkspace(name: string): Promise<void> {
  const current = page.getByRole("button", { name: `Workspace: ${name}. Switch workspace` });
  if (await current.isVisible()) return;
  await page.getByRole("button", { name: /Switch workspace|Choose a workspace/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
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

/** Opens the workspace's Chat page from the sidebar, where the conversation panel lives. */
async function openWorkspaceChat(): Promise<void> {
  await switchToWorkspace(workspaceName);
  await sidebarLink("Chat").click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/chat/);
  await expect(page.getByRole("textbox", { name: "Message the studio agent" })).toBeVisible();
}

async function sendMessage(text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message the studio agent" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function mcp(
  request: APIRequestContext,
  token: string,
  id: number,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const response = await request.post(`${settings.webUrl}/mcp`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    data: { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result ?? {};
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await agent?.close();
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

test("creates a workspace, opens it and lists it", async () => {
  await openAllWorkspaces();
  const dialog = await openDialog(
    page.getByRole("button", { name: "New workspace" }).first(),
    "New workspace",
  );
  await dialog.getByLabel("Name").fill(workspaceName);
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(dialog).toBeHidden();

  // A new workspace opens on its overview and becomes the one the sidebar works in.
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: workspaceName })).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Workspace: ${workspaceName}. Switch workspace` }),
  ).toBeVisible();

  await openAllWorkspaces();
  await expect(page.getByRole("link", { name: new RegExp(workspaceName) })).toBeVisible();
});

test("queues a message while no studio agent is paired", async () => {
  await openWorkspaceChat();
  await sendMessage("Draft a hook about bridges");

  await expect(page.getByText("Draft a hook about bridges")).toBeVisible();
  await expect(page.getByText("Waiting for studio agent (none paired)")).toBeVisible();
});

test("pairs a fake studio agent that streams the queued reply", async () => {
  const streamGate = latch();
  const replyGate = latch();
  const firstTurn = latch();
  const onChat = async (turn: ChatTurn) => {
    firstTurn.open();
    await streamGate.promise;
    turn.activity("WebSearch", "Searching for bridge facts");
    turn.stream("Bridges carry ");
    turn.stream("more than traffic");
    await replyGate.promise;
    turn.reply("Bridges carry more than traffic: they carry the story.");
  };

  await sidebarLink("Account settings").click();
  await expect(page).toHaveURL(/\/settings\/devices/);
  const pairing = await openDialog(
    page.getByRole("button", { name: "Pair a device" }).first(),
    "Pair a studio agent",
  );
  const code = await pairing.getByTestId("pairing-code").textContent();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  // Pair against the web origin, as the command in the dialog does; the dev server proxies the
  // pairing request and the bridge WebSocket to the API.
  const device = await pairDevice(settings.webUrl, code ?? "", deviceName);
  agent = new FakeStudioAgent({ serverUrl: settings.webUrl, token: device.token, onChat });
  const hello = await agent.connect();
  expect(hello.deviceId).toBe(device.deviceId);

  // The dialog closes by itself once the new device reports online.
  await expect(pairing).toBeHidden();
  const row = page.getByRole("row", { name: new RegExp(deviceName) });
  await expect(row.getByText("Online")).toBeVisible();

  // The queued job reaches the agent as soon as it connects.
  await firstTurn.promise;
  expect(agent.turns[0]?.text).toBe("Draft a hook about bridges");
  expect(agent.turns[0]?.producerSessionId).toBeUndefined();

  await openWorkspaceChat();
  await expect(page.getByText(/^Running/)).toBeVisible();
  streamGate.open();
  await expect(page.getByText("Bridges carry more than traffic")).toBeVisible();
  await expect(page.getByText("Searching for bridge facts")).toBeVisible();

  replyGate.open();
  await expect(
    page.getByText("Bridges carry more than traffic: they carry the story."),
  ).toBeVisible();
  await expect(page.getByText(/^Running/)).toBeHidden();

  // The reply is stored, not only streamed.
  await page.reload();
  await expect(
    page.getByText("Bridges carry more than traffic: they carry the story."),
  ).toBeVisible();
  expect(agent.invalidFrames).toEqual([]);
});

test("resumes the same producer session for a follow-up message", async () => {
  if (agent === null) throw new Error("no agent");
  agent.onChat = echoHandler;
  await sendMessage("Make it shorter");

  await expect(page.getByText("You said: Make it shorter")).toBeVisible();
  const [first, second] = agent.turns;
  const firstResult = [...agent.results.values()][0];
  expect(second?.text).toBe("Make it shorter");
  expect(second?.conversationId).toBe(first?.conversationId);
  expect(second?.producerSessionId).toBe(firstResult?.sdkSessionId);
});

test("shows the studio agent offline when it stops and runs the queued job when it returns", async () => {
  if (agent === null) throw new Error("no agent");
  await sidebarLink("Account settings").click();
  const row = page.getByRole("row", { name: new RegExp(deviceName) });
  await expect(row.getByText("Online")).toBeVisible();

  await agent.close();
  await expect(row.getByText("Offline")).toBeVisible();

  await openWorkspaceChat();
  await sendMessage("Sent while the studio was away");
  await expect(page.getByText("Waiting for studio agent (offline)")).toBeVisible();

  await agent.connect();
  await expect(page.getByText("You said: Sent while the studio was away")).toBeVisible();
  await expect(page.getByText("Waiting for studio agent (offline)")).toBeHidden();
});

test("serves MCP tools to an access token created in Settings", async ({ request }) => {
  await sidebarLink("Account settings").click();
  await page.getByRole("tab", { name: "Access tokens" }).click();
  await expect(page).toHaveURL(/\/settings\/tokens/);
  const dialog = await openDialog(
    page.getByRole("button", { name: "New token" }).first(),
    "New access token",
  );
  await dialog.getByLabel("Name").fill(`E2E client ${run}`);
  await dialog.getByRole("switch", { name: /Write/ }).click();
  await dialog.getByRole("button", { name: "Create token" }).click();
  const reveal = page.getByRole("dialog", { name: "Copy your new token" });
  const secret = (await reveal.getByTestId("token-secret").textContent()) ?? "";
  expect(secret).toMatch(/^lc_mcp_/);
  await reveal.getByRole("button", { name: "Done" }).click();
  await expect(reveal).toBeHidden();

  const list = await mcp(request, secret, 1, "tools/list");
  const names = (list.tools as { name: string }[]).map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining(["workspace.create", "workspace.get", "workspace.list"]),
  );

  const listed = await mcp(request, secret, 2, "tools/call", {
    name: "workspace.list",
    arguments: {},
  });
  const workspaces = (listed.structuredContent as { workspaces: { name: string }[] }).workspaces;
  expect(workspaces.map((workspace) => workspace.name)).toContain(workspaceName);

  // A workspace created over MCP appears in the open workspace list without a reload.
  await openAllWorkspaces();
  await expect(page.getByRole("link", { name: new RegExp(workspaceName) })).toBeVisible();
  const created = await mcp(request, secret, 3, "tools/call", {
    name: "workspace.create",
    arguments: { name: mcpWorkspaceName },
  });
  expect(created.isError).toBeFalsy();
  await expect(page.getByRole("link", { name: new RegExp(mcpWorkspaceName) })).toBeVisible();

  // Cookies never authorize MCP, and the token is required.
  const anonymous = await request.post(`${settings.webUrl}/mcp`, {
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    data: { jsonrpc: "2.0", id: 4, method: "tools/list" },
  });
  expect(anonymous.status()).toBe(401);
});

test("signs out", async () => {
  await page.getByRole("button", { name: new RegExp(settings.ownerName) }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.goto("/workspaces");
  await expect(page).toHaveURL(/\/login/);
});
