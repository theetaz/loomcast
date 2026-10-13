import { defineConfig, mergeConfig } from "vitest/config";
import { sharedVitestConfig } from "../../vitest.shared.ts";

export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    test: {
      include: ["test/**/*.test.ts"],
      globalSetup: ["./test/global-setup.ts"],
      hookTimeout: 60_000,
    },
  }),
);
