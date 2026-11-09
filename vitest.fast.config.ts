import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";
import { FAST_TEST_FILES } from "./tests/fast-files.ts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [...FAST_TEST_FILES],
    globalSetup: [],
    setupFiles: ["tests/helpers/install-clock.ts", "tests/helpers/install-markdown.ts", "tests/helpers/no-database.ts"],
    env: { ...base.test?.env, TOMOLA_TEST_NO_DB: "1" },
  },
});
