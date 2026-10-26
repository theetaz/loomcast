import type { KbSearchHit } from "@loomcast/contracts";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** Typing pauses this long before a search goes out. */
export const KB_SEARCH_DEBOUNCE_MS = 150;
/** Shorter queries do not search. */
export const KB_SEARCH_MIN_LENGTH = 2;
/** Hits the palette shows. */
export const KB_SEARCH_LIMIT = 8;

export type KbSearchState =
  | { status: "idle"; hits: KbSearchHit[] }
  | { status: "pending"; hits: KbSearchHit[] }
  | { status: "success"; hits: KbSearchHit[] }
  | { status: "error"; hits: KbSearchHit[]; error: unknown };

interface Settled {
  q: string;
  hits: KbSearchHit[];
  error?: unknown;
}

/**
 * Server-side knowledge-base search, in one workspace or across every one, for the palette.
 * Waits `KB_SEARCH_DEBOUNCE_MS` after the last keystroke, needs at least
 * `KB_SEARCH_MIN_LENGTH` characters, and aborts the request for an older
 * query as soon as the query changes, so a slow answer never lands late.
 * While a search runs, the previous hits stay up to keep the list steady.
 */
export function useKbSearch(query: string, workspaceId: string | null = null): KbSearchState {
  const q = query.trim();
  const active = q.length >= KB_SEARCH_MIN_LENGTH;
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (q.length < KB_SEARCH_MIN_LENGTH) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .request("kb.search", {
          query: { q, limit: KB_SEARCH_LIMIT, ...(workspaceId ? { workspaceId } : {}) },
          signal: controller.signal,
        })
        .then(
          (result) => {
            if (!controller.signal.aborted) setSettled({ q, hits: result.items });
          },
          (error: unknown) => {
            if (!controller.signal.aborted) setSettled({ q, hits: [], error });
          },
        );
    }, KB_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, workspaceId]);

  if (!active) return { status: "idle", hits: [] };
  if (!settled) return { status: "pending", hits: [] };
  if (settled.q !== q) return { status: "pending", hits: settled.hits };
  if (settled.error !== undefined) return { status: "error", hits: [], error: settled.error };
  return { status: "success", hits: settled.hits };
}
