import packageJson from "../package.json" with { type: "json" };

/** The studio agent's version, reported when pairing, in `hello` and by `system.ping`. */
export const AGENT_VERSION: string = packageJson.version;

/** Operating system and CPU architecture, for example `darwin-arm64`. */
export function detectPlatform(): string {
  return `${process.platform}-${process.arch}`;
}
