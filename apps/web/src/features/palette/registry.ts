import type { PaletteSource } from "./types";

const modules = import.meta.glob<{ source: PaletteSource }>("./sources/*.{ts,tsx}", {
  eager: true,
});

/** Every palette source, in display order. Fixed at build time, so hooks run in a stable order. */
export const paletteSources: readonly PaletteSource[] = Object.values(modules)
  .map((module) => module.source)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
