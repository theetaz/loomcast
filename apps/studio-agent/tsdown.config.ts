import { defineConfig } from "tsdown";

// One ESM bundle for the `studio-agent` bin. Workspace packages are inlined because they ship
// TypeScript source; third-party dependencies stay external and resolve from node_modules.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node22.12",
  outDir: "dist",
  clean: true,
  dts: false,
  deps: {
    alwaysBundle: [/^@loomcast\//],
  },
});
