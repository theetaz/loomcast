/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { msw } from "msw/vite";
import { defineConfig } from "vite";
import { sharedVitestConfig } from "../../vitest.shared.ts";
import { themeInit } from "./vite/theme-init.ts";

const API_TARGET = "http://127.0.0.1:8790";

// `vite --mode mock` serves the app against the in-browser mock API (src/mocks).
export default defineConfig(({ mode }) => ({
  plugins: [
    // Reads tsr.config.json; must run before the React plugin.
    tanstackRouter({ autoCodeSplitting: mode !== "test" }),
    react(),
    tailwindcss(),
    themeInit(),
    mode === "mock" && msw({ mode: "worker-only" }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // REST and the `/api/stream` server-sent events.
      "/api": { target: API_TARGET, changeOrigin: false },
      // Reserved for WebSocket endpoints.
      "/live": { target: API_TARGET, ws: true },
    },
  },
  build: {
    sourcemap: true,
  },
  test: {
    ...sharedVitestConfig.test,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    css: false,
  },
}));
