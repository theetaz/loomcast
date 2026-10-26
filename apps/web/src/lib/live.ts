import {
  type Device,
  LIVE_STREAM_PATH,
  type List,
  type LiveEvent,
  type LiveEventOf,
  type LiveEventType,
  parseLiveEvent,
  type Workspace,
} from "@loomcast/contracts";
import type { QueryClient } from "@tanstack/react-query";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { queryKeys } from "./query-keys";

/**
 * - `idle`: not started.
 * - `connecting`: first connection attempt.
 * - `open`: receiving events.
 * - `reconnecting`: the connection dropped; the browser or the backoff timer retries.
 * - `unsupported`: no `EventSource` (tests, very old browsers).
 */
export type LiveStatus = "idle" | "connecting" | "open" | "reconnecting" | "unsupported";

/** The subset of `EventSource` the client uses, so tests can pass a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const CLOSED = 2;

export interface LiveClientOptions {
  queryClient: QueryClient;
  url?: string;
  /** Defaults to the browser's `EventSource`; `null` when there is none. */
  createEventSource?: EventSourceFactory | null;
  /** Backoff for reconnecting after the browser gives up: doubles from `minDelayMs`. */
  minDelayMs?: number;
  maxDelayMs?: number;
}

export interface LiveClient {
  /** Opens the stream for the first user; calls nest, so pair each with `stop`. */
  start(): void;
  stop(): void;
  getStatus(): LiveStatus;
  onStatusChange(listener: () => void): () => void;
  /** Receives one event type, after the query caches were patched. */
  subscribe<T extends LiveEventType>(
    type: T,
    listener: (event: LiveEventOf<T>) => void,
  ): () => void;
  /** Called when the stream opens again after a drop; events may have been missed. */
  onReconnect(listener: () => void): () => void;
}

function defaultFactory(): EventSourceFactory | null {
  if (typeof EventSource === "undefined") return null;
  return (url) => new EventSource(url);
}

function upsertWorkspace(
  list: List<Workspace> | undefined,
  workspace: Workspace,
): List<Workspace> | undefined {
  if (!list) return list;
  const items = list.items.filter((item) => item.id !== workspace.id);
  items.push(workspace);
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { items };
}

/**
 * Patches the query caches for an event. Returns quietly for events that only
 * features care about (messages, deltas, job activity); they subscribe instead.
 */
export function applyLiveEvent(queryClient: QueryClient, event: LiveEvent) {
  switch (event.type) {
    case "workspace.created":
    case "workspace.updated": {
      const { workspace } = event.payload;
      queryClient.setQueryData<List<Workspace>>(queryKeys.workspaces.list, (list) =>
        upsertWorkspace(list, workspace),
      );
      queryClient.setQueryData(queryKeys.workspaces.detail(workspace.id), workspace);
      queryClient.setQueryData(queryKeys.workspaces.detail(workspace.slug), workspace);
      return;
    }
    case "device.status": {
      const { deviceId, online, lastSeenAt } = event.payload;
      const list = queryClient.getQueryData<List<Device>>(queryKeys.devices);
      if (!list?.items.some((device) => device.id === deviceId)) {
        // A device paired elsewhere: fetch it rather than guess its name.
        void queryClient.invalidateQueries({ queryKey: queryKeys.devices });
        return;
      }
      queryClient.setQueryData<List<Device>>(queryKeys.devices, {
        items: list.items.map((device) =>
          device.id === deviceId ? { ...device, online, lastSeenAt } : device,
        ),
      });
      return;
    }
    case "job.updated":
      queryClient.setQueryData(queryKeys.jobs.detail(event.payload.job.id), event.payload.job);
      return;
    case "resync":
      void queryClient.invalidateQueries();
      return;
    default:
      return;
  }
}

/**
 * One `EventSource` on `/api/stream` for the whole app. The browser retries a
 * dropped connection by itself (and the server replays from `Last-Event-ID`);
 * when it gives up, for example after an error response, the client opens a
 * new one with exponential backoff. Every reopen refetches the active queries,
 * because a fresh connection cannot replay what it missed.
 */
export function createLiveClient(options: LiveClientOptions): LiveClient {
  const { queryClient, url = LIVE_STREAM_PATH, minDelayMs = 1_000, maxDelayMs = 30_000 } = options;
  const factory =
    options.createEventSource === undefined ? defaultFactory() : options.createEventSource;

  const typeListeners = new Map<LiveEventType, Set<(event: LiveEvent) => void>>();
  const statusListeners = new Set<() => void>();
  const reconnectListeners = new Set<() => void>();

  let users = 0;
  let status: LiveStatus = factory ? "idle" : "unsupported";
  let source: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let hasOpened = false;

  function setStatus(next: LiveStatus) {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) listener();
  }

  function dispatch(event: LiveEvent) {
    applyLiveEvent(queryClient, event);
    for (const listener of typeListeners.get(event.type) ?? []) listener(event);
  }

  function scheduleReconnect() {
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** failures);
    failures += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  }

  function connect() {
    if (!factory) return;
    const current = factory(url);
    source = current;
    setStatus(hasOpened ? "reconnecting" : "connecting");

    current.onopen = () => {
      failures = 0;
      setStatus("open");
      if (hasOpened) {
        void queryClient.invalidateQueries({ refetchType: "active" });
        for (const listener of reconnectListeners) listener();
      }
      hasOpened = true;
    };
    current.onmessage = (message) => {
      const event = parseLiveEvent(message.data);
      if (event) dispatch(event);
    };
    current.onerror = () => {
      if (source !== current) return;
      setStatus("reconnecting");
      if (current.readyState === CLOSED) {
        current.close();
        source = null;
        scheduleReconnect();
      }
    };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (source) {
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      source.close();
      source = null;
    }
    failures = 0;
    hasOpened = false;
    setStatus("idle");
  }

  return {
    start() {
      users += 1;
      if (users === 1 && factory) connect();
    },
    stop() {
      users = Math.max(0, users - 1);
      if (users === 0 && factory) disconnect();
    },
    getStatus: () => status,
    onStatusChange(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    subscribe(type, listener) {
      const set = typeListeners.get(type) ?? new Set();
      typeListeners.set(type, set);
      const wrapped = listener as (event: LiveEvent) => void;
      set.add(wrapped);
      return () => set.delete(wrapped);
    },
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
  };
}

const LiveClientContext = createContext<LiveClient | null>(null);

export function LiveProvider({ client, children }: { client: LiveClient; children: ReactNode }) {
  return createElement(LiveClientContext.Provider, { value: client }, children);
}

export function useLiveClient(): LiveClient {
  const client = useContext(LiveClientContext);
  if (!client) throw new Error("useLiveClient must be used inside a LiveProvider.");
  return client;
}

/** The connection state, for indicators. */
export function useLiveStatus(): LiveStatus {
  const client = useLiveClient();
  return useSyncExternalStore(client.onStatusChange, client.getStatus, client.getStatus);
}

/** Keeps the stream open while the calling component is mounted. Used once, by the app shell. */
export function useLiveEvents(): LiveStatus {
  const client = useLiveClient();
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  return useLiveStatus();
}

/** Calls `handler` for every event of `type`. The latest handler is used without resubscribing. */
export function useLiveEvent<T extends LiveEventType>(
  type: T,
  handler: (event: LiveEventOf<T>) => void,
) {
  const client = useLiveClient();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(
    () => client.subscribe(type, (event: LiveEventOf<T>) => handlerRef.current(event)),
    [client, type],
  );
}

/** Calls `handler` whenever the stream reopens after a drop. */
export function useLiveReconnect(handler: () => void) {
  const client = useLiveClient();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => client.onReconnect(() => handlerRef.current()), [client]);
}
