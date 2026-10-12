import { useCallback, useSyncExternalStore } from "react";

/**
 * Light, dark or system theme preference, stored in localStorage and applied as
 * the `dark` class on <html>. Theme changes are never animated: transitions are
 * switched off for the frame in which the class changes.
 */

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "loomcast-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage can throw when cookies are blocked.
    return null;
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches === true;
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = storage()?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/** Sets the `dark` class and `color-scheme` on the root without animating anything. */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement) {
  const isDark = theme === "dark";
  if (root.classList.contains("dark") === isDark && root.style.colorScheme === theme) return;

  const doc = root.ownerDocument;
  const pause = doc.createElement("style");
  pause.dataset.themeSwitch = "";
  pause.textContent =
    "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}";
  doc.head.appendChild(pause);

  root.classList.toggle("dark", isDark);
  root.style.colorScheme = theme;

  // Flush styles with transitions off, then re-enable them once the frame has painted.
  void doc.defaultView?.getComputedStyle(root).color;
  doc.defaultView?.setTimeout(() => pause.remove(), 1);
}

type Snapshot = { preference: ThemePreference; resolvedTheme: ResolvedTheme };

const listeners = new Set<() => void>();
let snapshot: Snapshot | null = null;

function computeSnapshot(): Snapshot {
  const preference = readThemePreference();
  return { preference, resolvedTheme: resolveTheme(preference, systemPrefersDark()) };
}

function commit(next: Snapshot) {
  const changed =
    snapshot?.preference !== next.preference || snapshot?.resolvedTheme !== next.resolvedTheme;
  snapshot = next;
  applyTheme(next.resolvedTheme);
  if (changed) for (const listener of listeners) listener();
}

function refresh() {
  commit(computeSnapshot());
}

function getSnapshot(): Snapshot {
  snapshot ??= computeSnapshot();
  return snapshot;
}

const serverSnapshot: Snapshot = { preference: "system", resolvedTheme: "light" };

function subscribe(listener: () => void) {
  listeners.add(listener);
  applyTheme(getSnapshot().resolvedTheme);

  // Follow the OS while the preference is "system", and other tabs' changes.
  const media = window.matchMedia?.(DARK_QUERY);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) refresh();
  };
  media?.addEventListener("change", refresh);
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    media?.removeEventListener("change", refresh);
    window.removeEventListener("storage", onStorage);
  };
}

/** Stores the preference, applies it and notifies every `useTheme` consumer. */
export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") storage()?.removeItem(THEME_STORAGE_KEY);
    else storage()?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Without storage the preference still applies for this page.
  }
  commit({ preference, resolvedTheme: resolveTheme(preference, systemPrefersDark()) });
}

/** Applies the stored preference. Call once before the first render. */
export function initTheme() {
  refresh();
}

export function useTheme() {
  const { preference, resolvedTheme } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => serverSnapshot,
  );
  const setPreference = useCallback((next: ThemePreference) => setThemePreference(next), []);
  return { preference, resolvedTheme, setPreference };
}

/**
 * Inline this in a `<script>` in index.html <head> so the right theme is set
 * before the first paint. It mirrors `initTheme` without importing anything.
 */
export const themeInitScript = `(()=>{try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=p==="dark"||(p!=="light"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light"}catch(e){}})()`;
