import type { Device, List, LiveEvent, Workspace } from "@loomcast/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveClient, type EventSourceLike } from "@/lib/live";
import { queryKeys } from "@/lib/query-keys";
import { mockId, mockWorkspace } from "@/mocks/db";

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  emit(event: LiveEvent | string) {
    const data = typeof event === "string" ? event : JSON.stringify(event);
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  /** `retrying`: the browser reconnects itself; otherwise it gave up (readyState CLOSED). */
  fail(retrying: boolean) {
    this.readyState = retrying ? 0 : 2;
    this.onerror?.(new Event("error"));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

function setup() {
  const queryClient = new QueryClient();
  const sources: FakeEventSource[] = [];
  const live = createLiveClient({
    queryClient,
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    minDelayMs: 1_000,
    maxDelayMs: 4_000,
  });
  const latest = () => {
    const source = sources.at(-1);
    if (!source) throw new Error("no event source");
    return source;
  };
  return { queryClient, live, sources, latest };
}

const device: Device = {
  id: mockId(),
  name: "Studio Mac mini",
  platform: "darwin-arm64",
  agentVersion: "0.1.0",
  online: false,
  lastSeenAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  revokedAt: null,
};

describe("live client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens one stream for every user and closes it after the last one", () => {
    const { live, sources } = setup();
    live.start();
    live.start();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.url).toBe("/api/stream");
    expect(live.getStatus()).toBe("connecting");

    sources[0]?.open();
    expect(live.getStatus()).toBe("open");

    live.stop();
    expect(sources[0]?.closed).toBe(false);
    live.stop();
    expect(sources[0]?.closed).toBe(true);
    expect(live.getStatus()).toBe("idle");
  });

  it("patches the workspace and device caches and notifies subscribers after", () => {
    const { live, latest, queryClient } = setup();
    const older = mockWorkspace({
      name: "Old",
      slug: "old",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    queryClient.setQueryData<List<Workspace>>(queryKeys.workspaces.list, { items: [older] });
    queryClient.setQueryData<List<Device>>(queryKeys.devices, { items: [device] });

    const seen: string[] = [];
    live.subscribe("workspace.created", (event) => {
      seen.push(event.payload.workspace.name);
      // The cache is already patched when features hear about the event.
      expect(
        queryClient.getQueryData<List<Workspace>>(queryKeys.workspaces.list)?.items,
      ).toHaveLength(2);
    });

    live.start();
    latest().open();
    const created = mockWorkspace({
      name: "New",
      slug: "new",
      updatedAt: "2026-10-12T00:00:00.000Z",
    });
    latest().emit({ type: "workspace.created", payload: { workspace: created } });
    latest().emit({
      type: "device.status",
      payload: { deviceId: device.id, online: true, lastSeenAt: "2026-10-12T00:00:00.000Z" },
    });
    latest().emit("{not json");
    latest().emit(JSON.stringify({ type: "from.the.future", payload: {} }));

    expect(seen).toEqual(["New"]);
    expect(
      queryClient
        .getQueryData<List<Workspace>>(queryKeys.workspaces.list)
        ?.items.map((p) => p.slug),
    ).toEqual(["new", "old"]);
    expect(queryClient.getQueryData(queryKeys.workspaces.detail("new"))).toEqual(created);
    expect(queryClient.getQueryData<List<Device>>(queryKeys.devices)?.items[0]?.online).toBe(true);
  });

  it("refetches devices it does not know and everything on resync", () => {
    const { live, latest, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    live.start();
    latest().open();

    latest().emit({
      type: "device.status",
      payload: { deviceId: device.id, online: true, lastSeenAt: null },
    });
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: queryKeys.devices });

    latest().emit({ type: "resync", payload: {} });
    expect(invalidate).toHaveBeenLastCalledWith();
  });

  it("reopens with backoff after the browser gives up, then refetches", () => {
    const { live, sources, latest, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const reconnected = vi.fn();
    live.onReconnect(reconnected);

    live.start();
    latest().open();
    latest().fail(false);
    expect(live.getStatus()).toBe("reconnecting");
    expect(sources[0]?.closed).toBe(true);

    vi.advanceTimersByTime(999);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);

    // The second attempt fails too: the wait doubles.
    latest().fail(false);
    vi.advanceTimersByTime(1_999);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);

    latest().open();
    expect(live.getStatus()).toBe("open");
    expect(reconnected).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ refetchType: "active" });
  });

  it("lets the browser retry by itself while the source is still connecting", () => {
    const { live, sources, latest } = setup();
    live.start();
    latest().open();
    latest().fail(true);
    expect(live.getStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(10_000);
    expect(sources).toHaveLength(1);
    latest().open();
    expect(live.getStatus()).toBe("open");
  });

  it("stays quiet without EventSource", () => {
    const live = createLiveClient({ queryClient: new QueryClient(), createEventSource: null });
    live.start();
    expect(live.getStatus()).toBe("unsupported");
    live.stop();
    expect(live.getStatus()).toBe("unsupported");
  });
});
