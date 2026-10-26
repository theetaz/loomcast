import type {
  ActorKind,
  JobType,
  LiveEvent,
  PipelineState,
  SeriesStatus,
  TransitionVia,
} from "@loomcast/contracts";
import type { Logger } from "./logger";

/**
 * Events that stay inside the api process. They are never sent to browsers.
 * - `job.enqueued`: a job was inserted (published after commit); wakes the dispatcher.
 * - `device.revoked`: a device was revoked; the bridge hub closes its socket with 4403.
 * - `content.item.state_changed`: an item moved between pipeline states, or onto a new version in
 *   the same state (`from === to`). Published after commit by the content service, the only
 *   writer of `content_items.state`.
 * - `format.updated`: a format got a new version (published after commit).
 * - `series.updated`: a series was renamed, moved to another format, paused, resumed or archived.
 */
export type InternalEvent =
  | {
      type: "job.enqueued";
      payload: {
        jobId: string;
        type: JobType;
        workspaceId: string;
        deviceAffinity: string | null;
      };
    }
  | {
      type: "device.revoked";
      payload: { deviceId: string; tokenId: string };
    }
  | {
      type: "content.item.state_changed";
      payload: ContentStateChange;
    }
  | {
      type: "format.updated";
      payload: {
        formatId: string;
        workspaceId: string;
        versionId: string;
        previousVersionId: string;
      };
    }
  | {
      type: "series.updated";
      payload: {
        seriesId: string;
        workspaceId: string;
        status: SeriesStatus;
        previousStatus: SeriesStatus;
        formatId: string;
        previousFormatId: string;
      };
    };

/** A committed move of a content item (`content.item.state_changed`). */
export interface ContentStateChange {
  itemId: string;
  workspaceId: string;
  from: PipelineState;
  to: PipelineState;
  /** Who moved it; `id` is the user, token or device id, null for the system. */
  actor: { kind: ActorKind; id: string | null };
  /** The version the item is on after the move. */
  versionId: string;
  previousVersionId: string;
  via: TransitionVia;
  reason: string | null;
}

export const INTERNAL_EVENT_TYPES = [
  "job.enqueued",
  "device.revoked",
  "content.item.state_changed",
  "format.updated",
  "series.updated",
] as const satisfies readonly InternalEvent["type"][];

export type BusEvent = LiveEvent | InternalEvent;
export type BusEventType = BusEvent["type"];
export type BusEventOf<T extends BusEventType> = Extract<BusEvent, { type: T }>;

export type Listener<E> = (event: E) => void | Promise<void>;
export type Unsubscribe = () => void;

/**
 * Typed in-process publish/subscribe. Listeners run synchronously in subscription order. A
 * listener that throws or rejects is logged and never affects the publisher or other listeners.
 */
export interface EventBus {
  publish(event: BusEvent): void;
  /** Listens to one event type. */
  subscribe<T extends BusEventType>(type: T, listener: Listener<BusEventOf<T>>): Unsubscribe;
  /** Listens to every event that browsers may see, for the `/api/stream` fan-out. */
  subscribeLive(listener: Listener<LiveEvent>): Unsubscribe;
}

const internalTypes: ReadonlySet<string> = new Set(INTERNAL_EVENT_TYPES);

export function isInternalEvent(event: BusEvent): event is InternalEvent {
  return internalTypes.has(event.type);
}

export function createEventBus(logger?: Logger): EventBus {
  const byType = new Map<string, Set<Listener<BusEvent>>>();
  const live = new Set<Listener<LiveEvent>>();

  function invoke<E extends BusEvent>(listener: Listener<E>, event: E): void {
    const onError = (error: unknown) =>
      logger?.error({ err: error, eventType: event.type }, "event listener failed");
    try {
      const result = listener(event);
      if (result instanceof Promise) {
        result.catch(onError);
      }
    } catch (error) {
      onError(error);
    }
  }

  return {
    publish(event) {
      for (const listener of [...(byType.get(event.type) ?? [])]) {
        invoke(listener, event);
      }
      if (!isInternalEvent(event)) {
        for (const listener of [...live]) {
          invoke(listener, event);
        }
      }
    },
    subscribe(type, listener) {
      let listeners = byType.get(type);
      if (listeners === undefined) {
        listeners = new Set();
        byType.set(type, listeners);
      }
      const entry = listener as Listener<BusEvent>;
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    subscribeLive(listener) {
      live.add(listener);
      return () => {
        live.delete(listener);
      };
    },
  };
}
