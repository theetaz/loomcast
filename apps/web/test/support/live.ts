import type { LiveEvent } from "@loomcast/contracts";
import type { EventSourceFactory, EventSourceLike } from "@/lib/live";
import type { MockDb } from "@/mocks/db";

/** An `EventSource` the test drives by hand. */
export class FakeEventSource implements EventSourceLike {
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

  emit(event: LiveEvent) {
    if (this.closed) return;
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
  }

  /** `retrying`: the browser reconnects by itself; otherwise it gave up. */
  fail(retrying: boolean) {
    this.readyState = retrying ? 0 : 2;
    this.onerror?.(new Event("error"));
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

/**
 * Event sources that open straight away and carry everything the mock API
 * publishes on `db`, like the real `/api/stream` would.
 */
export function fakeStream(db: MockDb) {
  const sources: FakeEventSource[] = [];
  const factory: EventSourceFactory = (url) => {
    const source = new FakeEventSource(url);
    sources.push(source);
    db.listeners.add((event) => source.emit(event));
    queueMicrotask(() => source.open());
    return source;
  };
  const latest = () => {
    const source = sources.at(-1);
    if (!source) throw new Error("The live stream was never opened.");
    return source;
  };
  return { factory, sources, latest };
}
