import { defineConfig } from "tsdown";

// ESM bundles for the server and the admin CLI. Workspace packages are inlined because they ship
// TypeScript source; third-party dependencies stay external and resolve from node_modules.
export default defineConfig({
  entry: ["src/server.ts", "src/cli/admin.ts"],
  format: "esm",
  platform: "node",
  target: "node22.12",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: true,
  deps: {
    alwaysBundle: [/^@loomcast\//],
  },
});
