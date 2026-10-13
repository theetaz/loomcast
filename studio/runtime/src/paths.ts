import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Every path the runtime needs is derived from the studio workspace root. A caller that bundles
// this package (and so moves `import.meta.url`) passes `studioRoot` explicitly instead.

/** The studio workspace root: the directory that holds `package.json`, `style-library/` and `runtime/`. */
export function resolveStudioRoot(from: string = import.meta.url): string {
  let dir = dirname(from.startsWith("file:") ? fileURLToPath(from) : from);
  for (;;) {
    if (existsSync(join(dir, "style-library")) && existsSync(join(dir, "runtime"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not find the studio workspace root; pass studioRoot explicitly");
    }
    dir = parent;
  }
}

/** The fixed locations inside a studio workspace. */
export interface StudioPaths {
  root: string;
  styleLibrary: string;
  registry: string;
  skills: string;
  shellTemplate: string;
  gsap: string;
  hyperframesBin: string;
}

export function studioPaths(studioRoot: string = resolveStudioRoot()): StudioPaths {
  const root = resolve(studioRoot);
  return {
    root,
    styleLibrary: join(root, "style-library"),
    registry: join(root, "style-library", "registry.json"),
    skills: join(root, "skills"),
    shellTemplate: join(root, "runtime", "templates", "vertical-shell"),
    gsap: join(root, "node_modules", "gsap", "dist", "gsap.min.js"),
    hyperframesBin: join(root, "node_modules", "hyperframes", "bin", "hyperframes.mjs"),
  };
}
