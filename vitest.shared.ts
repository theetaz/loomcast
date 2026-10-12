import { defineConfig } from "vitest/config";

// Base Vitest configuration. Packages merge it with `mergeConfig` from "vitest/config".
export const sharedVitestConfig = defineConfig({
  test: {
    pool: "forks",
    testTimeout: 20_000,
    passWithNoTests: true,
  },
});
