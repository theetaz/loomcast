import { defineConfig } from "tsdown";

// One ESM bundle for the `studio-agent` bin. Workspace packages are inlined because they ship
// TypeScript source; third-party dependencies stay external and resolve from node_modules. The
// studio runtime is inlined too, so its own dependencies (the HTML parser) come with it, and the
// agent passes it the studio folder explicitly (`LOOMCAST_STUDIO_ROOT`, else found from dist/).
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
    onlyBundle: ["parse5", "entities"],
  },
});
