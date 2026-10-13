import { defineConfig, mergeConfig } from "vitest/config";
import { sharedVitestConfig } from "../vitest.shared.ts";

export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    test: {
      include: ["runtime/test/**/*.test.ts"],
    },
  }),
);
