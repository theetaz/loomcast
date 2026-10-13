import { useSyncExternalStore } from "react";

/*
 * The palette body (cmdk, the command menu and every source) lives in its own
 * chunk. This module stays in the main chunk: it starts the import early
 * (on idle, or when the pointer or focus reaches the search button) and tells
 * the button once the chunk is there, so opening never waits on the network.
 */

export type PaletteModule = typeof import("./CommandPalette");

const importPalette = (): Promise<PaletteModule> => import("./CommandPalette");

let importer: () => Promise<PaletteModule> = importPalette;
let pending: Promise<PaletteModule> | null = null;
let loaded: PaletteModule | null = null;
const listeners = new Set<() => void>();

/** Starts loading the palette chunk once; later calls share the same promise. A failure can be retried. */
export function preloadPalette(): Promise<PaletteModule> {
  pending ??= importer().then(
    (module) => {
      loaded = module;
      for (const listener of listeners) listener();
      return module;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The palette module once its chunk has loaded, else null. */
export function usePaletteModule(): PaletteModule | null {
  return useSyncExternalStore(
    subscribe,
    () => loaded,
    () => null,
  );
}

/**
 * Tests only: forgets the loaded chunk and, optionally, swaps the importer
 * (for example for one that resolves later).
 */
export function resetPaletteLoader(next: () => Promise<PaletteModule> = importPalette) {
  importer = next;
  pending = null;
  loaded = null;
}

/** Runs `task` when the browser is idle, or after a short delay where idle callbacks are missing. */
export function whenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(task, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const timer = setTimeout(task, 200);
  return () => clearTimeout(timer);
}
