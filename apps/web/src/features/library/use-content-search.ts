import type { ContentItem } from "@loomcast/contracts";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** Typing pauses this long before a search goes out. */
export const CONTENT_SEARCH_DEBOUNCE_MS = 150;
/** Shorter queries do not search. */
export const CONTENT_SEARCH_MIN_LENGTH = 2;
/** Items the palette shows. */
export const CONTENT_SEARCH_LIMIT = 6;

export type ContentSearchState =
  | { status: "idle"; items: ContentItem[] }
  | { status: "pending"; items: ContentItem[] }
  | { status: "success"; items: ContentItem[] }
  | { status: "error"; items: ContentItem[]; error: unknown };

interface Settled {
  q: string;
  items: ContentItem[];
  error?: unknown;
}

/**
 * Content items of every project whose title or pitch matches `query`, for the palette. Waits
 * after the last keystroke, needs a few characters, and aborts the request for an older query as
 * soon as the query changes. The previous items stay up while a search runs.
 */
export function useContentSearch(query: string): ContentSearchState {
  const q = query.trim();
  const active = q.length >= CONTENT_SEARCH_MIN_LENGTH;
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (q.length < CONTENT_SEARCH_MIN_LENGTH) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .request("content.list", {
          query: { q, limit: CONTENT_SEARCH_LIMIT },
          signal: controller.signal,
        })
        .then(
          (page) => {
            if (!controller.signal.aborted) setSettled({ q, items: page.items });
          },
          (error: unknown) => {
            if (!controller.signal.aborted) setSettled({ q, items: [], error });
          },
        );
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  if (!active) return { status: "idle", items: [] };
  if (!settled) return { status: "pending", items: [] };
  if (settled.q !== q) return { status: "pending", items: settled.items };
  if (settled.error !== undefined) return { status: "error", items: [], error: settled.error };
  return { status: "success", items: settled.items };
}
