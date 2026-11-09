import { configDefaults, defineConfig } from "vitest/config";
import base from "./vitest.config.ts";
import { FAST_TEST_FILES } from "./tests/fast-files.ts";

// Everything outside the verified no-DB list keeps the original fixtures and guards.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    exclude: [...configDefaults.exclude, ...FAST_TEST_FILES],
  },
});
