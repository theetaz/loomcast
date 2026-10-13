import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";

/** Most rows Recent keeps. */
export const RECENT_LIMIT = 5;

const STORAGE_PREFIX = "loomcast-palette-recent";

/** In-app paths only: one leading slash, never a protocol-relative `//host`. */
const AppPathSchema = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)/);

const RecentEntrySchema = z.object({
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(50),
  label: z.string().max(300),
  href: AppPathSchema,
  detail: z.string().max(300).optional(),
});
export type RecentEntry = z.infer<typeof RecentEntrySchema>;

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage can throw when cookies are blocked.
    return null;
  }
}

/** The stored entries for a user, newest first. Anything malformed is dropped. */
export function readRecent(userId: string): RecentEntry[] {
  try {
    const raw = storage()?.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => RecentEntrySchema.safeParse(entry))
      .flatMap((result) => (result.success ? [result.data] : []))
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();
const snapshots = new Map<string, { raw: string | null; entries: RecentEntry[] }>();

function snapshot(userId: string): RecentEntry[] {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(storageKey(userId)) ?? null;
  } catch {
    raw = null;
  }
  const cached = snapshots.get(userId);
  if (cached && cached.raw === raw) return cached.entries;
  const entries = readRecent(userId);
  snapshots.set(userId, { raw, entries });
  return entries;
}

/** Moves `entry` to the front, without duplicates, keeping at most `RECENT_LIMIT`. */
export function recordRecent(userId: string, entry: RecentEntry) {
  const parsed = RecentEntrySchema.safeParse(entry);
  if (!parsed.success) return;
  const next = [parsed.data, ...readRecent(userId).filter((item) => item.id !== entry.id)].slice(
    0,
    RECENT_LIMIT,
  );
  try {
    storage()?.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    // Without storage the palette simply has no Recent group.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(STORAGE_PREFIX)) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The user's recent palette picks, newest first, and a way to add one. */
export function useRecent(userId: string) {
  const entries = useSyncExternalStore(
    subscribe,
    () => snapshot(userId),
    () => [],
  );
  const record = useCallback((entry: RecentEntry) => recordRecent(userId, entry), [userId]);
  return { entries, record };
}
