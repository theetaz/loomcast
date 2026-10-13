import type { Device, LiveEvent } from "@loomcast/contracts";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http, type RequestHandler } from "msw";
import { describe, expect, it } from "vitest";
import { formatCountdown, formatPlatform } from "@/features/settings/format";
import { pairCommand } from "@/features/settings/PairDeviceDialog";
import { createLiveClient, type EventSourceLike } from "@/lib/live";
import { createQueryClient } from "@/lib/query-client";
import { createMockDb, type MockDb, mockId, mockPairingCode, pairMockDevice } from "@/mocks/db";
import { createHandlers } from "@/mocks/handlers";
import { createAppRouter } from "@/router";
import { server } from "./support/server";

/** An `/api/stream` stand-in that forwards what the mock API publishes, like the SSE handler. */
class MockStream implements EventSourceLike {
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly forward = (event: LiveEvent) =>
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));

  constructor(private readonly db: MockDb) {
    db.listeners.add(this.forward);
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  close() {
    this.readyState = 2;
    this.db.listeners.delete(this.forward);
  }
}

/** Like `renderApp`, with a live stream fed by the mock db. */
function renderWithLive(path: string, db: MockDb, overrides: RequestHandler[] = []) {
  server.use(...overrides, ...createHandlers(db));
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  });
  const live = createLiveClient({ queryClient, createEventSource: () => new MockStream(db) });
  const router = createAppRouter({
    queryClient,
    live,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const user = userEvent.setup();
  render(<RouterProvider router={router} />);
  return { user, queryClient, router };
}

function device(overrides: Partial<Device> & Pick<Device, "name">): Device {
  return {
    id: mockId(),
    platform: "darwin-arm64",
    agentVersion: "0.1.0",
    online: true,
    lastSeenAt: "2026-10-12T09:00:00.000Z",
    createdAt: "2026-10-01T09:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

/** The command as shown; the code is wrapped so it never splits at its hyphen. */
function commandText(dialog: HTMLElement): string | null | undefined {
  return dialog.querySelector("pre code")?.textContent;
}

function signedInDb(devices: Device[] = [device({ name: "Studio Mac mini" })]) {
  return createMockDb({ signedIn: true, devices });
}

describe("devices settings", () => {
  it("lists paired devices with platform, version and live status", async () => {
    const db = signedInDb([
      device({ name: "Studio Mac mini" }),
      device({ name: "Old iMac", platform: "darwin-x64", online: false, agentVersion: "0.0.9" }),
      device({ name: "Gone", revokedAt: "2026-10-02T09:00:00.000Z" }),
    ]);
    renderWithLive("/settings/devices", db);

    const table = await screen.findByRole("table", { name: "Paired devices" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Studio Mac mini");
    expect(rows[0]).toHaveTextContent("macOS · Apple silicon");
    expect(rows[0]).toHaveTextContent("0.1.0");
    expect(within(rows[0] as HTMLElement).getByText("Online")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Offline")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("macOS · Intel");

    // `device.status` flips the pill without a refetch.
    const oldImac = db.devices[1] as Device;
    for (const listener of db.listeners) {
      listener({
        type: "device.status",
        payload: { deviceId: oldImac.id, online: true, lastSeenAt: new Date().toISOString() },
      });
    }
    await waitFor(() =>
      expect(within(rows[1] as HTMLElement).getByText("Online")).toBeInTheDocument(),
    );
  });

  it("shows an empty state with a way to pair", async () => {
    renderWithLive("/settings/devices", signedInDb([]));

    expect(await screen.findByText("No studio agent yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Pair a device" })).toHaveLength(2);
  });

  it("revokes a device after confirming", async () => {
    const db = signedInDb();
    const { user } = renderWithLive("/settings/devices", db);

    await user.click(await screen.findByRole("button", { name: "Revoke Studio Mac mini" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke Studio Mac mini?" });
    await user.click(within(confirm).getByRole("button", { name: "Revoke device" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(db.devices[0]?.revokedAt).not.toBeNull();
    expect(await screen.findByText("No studio agent yet")).toBeInTheDocument();
    expect(await screen.findByText("Device revoked")).toBeInTheDocument();
  });
});

describe("pair a device dialog", () => {
  it("shows the code and command, then closes when the new agent comes online", async () => {
    const db = signedInDb();
    const { user } = renderWithLive("/settings/devices", db);

    await user.click(await screen.findByRole("button", { name: "Pair a device" }));
    const dialog = await screen.findByRole("dialog", { name: "Pair a studio agent" });

    const code = await within(dialog).findByTestId("pairing-code");
    const issued = db.pairingCodes[0]?.code as string;
    expect(db.pairingCodes).toHaveLength(1);
    expect(code).toHaveTextContent(issued);
    expect(within(dialog).getByTestId("pairing-countdown")).toHaveTextContent(/^(10:00|9:5\d)$/);

    const command = pairCommand(window.location.origin, issued);
    expect(commandText(dialog)).toBe(command);
    await user.click(within(dialog).getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe(command);
    expect(within(dialog).getByText("Copied")).toBeInTheDocument();

    // A device that was already paired coming online is not the new one.
    const existing = db.devices[0] as Device;
    for (const listener of db.listeners) {
      listener({
        type: "device.status",
        payload: { deviceId: existing.id, online: true, lastSeenAt: new Date().toISOString() },
      });
    }
    expect(screen.getByRole("dialog", { name: "Pair a studio agent" })).toBeInTheDocument();

    // The agent pairs with the code and connects: the server publishes `device.status`.
    pairMockDevice(db, { name: "Edit Bay MacBook" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Studio agent paired")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Paired devices" });
    expect(await within(table).findByText("Edit Bay MacBook")).toBeInTheDocument();
  });

  it("offers a new code once the code expires", async () => {
    const db = signedInDb();
    const first = mockPairingCode().code;
    let second = mockPairingCode().code;
    while (second === first) second = mockPairingCode().code;
    let calls = 0;
    const overrides = [
      http.post("*/api/devices/pairing-codes", () => {
        calls += 1;
        const expiresAt = new Date(Date.now() + (calls === 1 ? -1_000 : 600_000)).toISOString();
        return HttpResponse.json(
          { code: calls === 1 ? first : second, expiresAt },
          { status: 201 },
        );
      }),
    ];
    const { user } = renderWithLive("/settings/devices", db, overrides);

    await user.click(await screen.findByRole("button", { name: "Pair a device" }));
    const dialog = await screen.findByRole("dialog", { name: "Pair a studio agent" });

    expect(await within(dialog).findByText("This code expired.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Copy command" })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Get a new code" }));
    expect(await within(dialog).findByTestId("pairing-code")).toHaveTextContent(second);
    expect(commandText(dialog)?.endsWith(`--code ${second}`)).toBe(true);
  });

  it("explains a failure and retries", async () => {
    const pairing = mockPairingCode();
    let fail = true;
    const overrides = [
      http.post("*/api/devices/pairing-codes", () =>
        fail
          ? HttpResponse.json({ error: { code: "internal", message: "Boom" } }, { status: 500 })
          : HttpResponse.json(pairing, { status: 201 }),
      ),
    ];
    const { user } = renderWithLive("/settings/devices", signedInDb(), overrides);

    await user.click(await screen.findByRole("button", { name: "Pair a device" }));
    const dialog = await screen.findByRole("dialog", { name: "Pair a studio agent" });
    expect(await within(dialog).findByText("Couldn't create a pairing code")).toBeInTheDocument();

    fail = false;
    await user.click(within(dialog).getByRole("button", { name: /try again/i }));
    expect(await within(dialog).findByTestId("pairing-code")).toHaveTextContent(pairing.code);
  });
});

describe("settings formatting", () => {
  it("formats platforms and countdowns", () => {
    expect(formatPlatform("darwin-arm64")).toBe("macOS · Apple silicon");
    expect(formatPlatform("linux-x64")).toBe("Linux · x64");
    expect(formatPlatform("plan9")).toBe("plan9");
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(61_001)).toBe("1:02");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});
