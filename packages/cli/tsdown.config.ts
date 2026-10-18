import { defineConfig } from "tsdown";

// One ESM file for the `loomcast` bin. The CLI has no runtime dependencies: it speaks MCP's
// JSON-RPC over HTTP with Node's own fetch.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node22.12",
  outDir: "dist",
  clean: true,
  dts: false,
});
