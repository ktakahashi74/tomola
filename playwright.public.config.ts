import { defineConfig } from "@playwright/test";
import privateConfig from "./playwright.config";
import { publicReadingTests } from "./e2e/reading-modes";

export default defineConfig({
  ...privateConfig,
  metadata: { publicReading: true },
  grep: publicReadingTests,
  grepInvert: undefined,
  outputDir: process.env.E2E_BROWSER_OUTPUT ?? "test-results-public",
});
