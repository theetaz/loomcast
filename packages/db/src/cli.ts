import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when the module at `moduleUrl` is the script node was started with. */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(moduleUrl);
}
