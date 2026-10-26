import { screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_WORKSPACE_KEY } from "@/features/workspace/home";
import { mockChannel } from "@/mocks/calendar";
import { mockWorkspace } from "@/mocks/db";
import { CALENDAR_NOW, CALENDAR_ZONE, calendarSetup } from "./support/calendar";
import { recordRequests } from "./support/kb";
import { renderApp } from "./support/render";

const previousZone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = CALENDAR_ZONE;
});
afterAll(() => {
  process.env.TZ = previousZone;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CALENDAR_NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * The calendar setup (Rust, with Instagram and Threads channels) plus a second workspace, Agents,
 * with a channel of its own. Agents was updated most recently.
 */
function twoWorkspaces() {
  const setup = calendarSetup();
  const agents = mockWorkspace({
    name: "Agents for small teams",
    slug: "agents-for-small-teams",
    updatedAt: "2026-10-14T09:00:00.000Z",
  });
  const agentsInstagram = mockChannel({
    workspaceId: agents.id,
    platform: "instagram",
    displayName: "@agents.smallteams",
    createdAt: "2026-10-01T08:00:00.000Z",
  });
  setup.db.workspaces.push(agents);
  setup.db.channels.push(agentsInstagram);
  return { ...setup, agents, agentsInstagram };
}

describe("a workspace's calendar", () => {
  it("filters by the workspace's own channels and asks for its posts only", async () => {
    const { db, workspace, agents } = twoWorkspaces();
    const requests = recordRequests();
    const { user } = renderApp(`/w/${workspace.slug}/calendar`, db);
    await screen.findByRole("heading", { name: "12 – 18 Oct 2026" });

    await user.click(await screen.findByRole("button", { name: "Channels: All channels" }));
    const options = await screen.findAllByRole("menuitemcheckbox");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("@rustin60"),
      expect.stringContaining("Rust threads"),
    ]);
    expect(screen.queryByRole("menuitemcheckbox", { name: /@agents\.smallteams/ })).toBeNull();
    await user.keyboard("{Escape}");

    const calendars = requests.filter((request) => request.path === "/api/calendar");
    expect(calendars.length).toBeGreaterThan(0);
    expect(calendars.every((request) => request.query.get("workspaceId") === workspace.id)).toBe(
      true,
    );
    expect(requests.some((request) => request.path.includes(agents.id))).toBe(false);

    // The sidebar lists the same channels, each opening this workspace's calendar.
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    const channels = within(nav).getByRole("list", { name: "Channels" });
    await within(channels).findByRole("link", { name: /Rust threads/ });
    expect(within(channels).getAllByRole("link")).toHaveLength(2);
    expect(within(channels).getByRole("link", { name: /Rust threads/ })).toHaveAttribute(
      "href",
      expect.stringMatching(new RegExp(`^/w/${workspace.slug}/calendar\\?channels=`)),
    );
  });

  it("shows another workspace only its own channels", async () => {
    const { db, agents } = twoWorkspaces();
    const requests = recordRequests();
    const { user } = renderApp(`/w/${agents.slug}/calendar`, db);
    await screen.findByRole("heading", { name: "12 – 18 Oct 2026" });

    await user.click(await screen.findByRole("button", { name: "Channels: All channels" }));
    const options = await screen.findAllByRole("menuitemcheckbox");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("@agents.smallteams"),
    ]);
    const calendars = requests.filter((request) => request.path === "/api/calendar");
    expect(calendars.every((request) => request.query.get("workspaceId") === agents.id)).toBe(true);
  });
});

describe("old channel settings address", () => {
  it("opens the remembered workspace's channel settings", async () => {
    const { db, workspace } = twoWorkspaces();
    window.localStorage.setItem(LAST_WORKSPACE_KEY, workspace.id);
    const { router } = renderApp("/settings/channels", db);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/w/${workspace.slug}/settings/channels`),
    );
    expect(await screen.findByRole("list", { name: "Channel settings" })).toBeInTheDocument();
  });

  it("opens the most recently updated workspace when none is remembered", async () => {
    const { db, agents } = twoWorkspaces();
    const { router } = renderApp("/settings/channels", db);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/w/${agents.slug}/settings/channels`),
    );
  });
});
