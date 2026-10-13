import { defineConfig } from "tsdown";

// ESM bundles for the server, the admin CLI and the production entry (migrate, then serve).
// Workspace packages are inlined because they ship TypeScript source; third-party dependencies
// stay external and resolve from node_modules.
export default defineConfig({
  entry: ["src/server.ts", "src/cli/admin.ts", "src/cli/migrate-and-start.ts"],
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
