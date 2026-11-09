import { defineConfig, devices } from "@playwright/test";
import { publicOnlyTests } from "./e2e/reading-modes";
import { browserFilePatterns, browserGroupCount } from "./scripts/browser-groups";

// Browser tests (pnpm test:e2e): e2e/global-setup.ts starts the development server and prepares a temporary DB.
// One server and DB: run tests serially in one worker.
export default defineConfig({
  metadata: { publicReading: false },
  grepInvert: publicOnlyTests,
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  ...(process.env.E2E_BROWSER_GROUP && process.env.E2E_BROWSER_GROUP !== "public" ? { testMatch: browserFilePatterns(process.cwd(), process.env.E2E_BROWSER_GROUP, browserGroupCount(process.env.E2E_GROUPS)) } : {}),
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["./scripts/browser-reporter.ts"]],
  ...(process.env.E2E_BROWSER_OUTPUT ? { outputDir: process.env.E2E_BROWSER_OUTPUT } : {}),
  use: {
    baseURL: `${process.env.E2E_SERVER === "build" ? "https" : "http"}://localhost:${process.env.E2E_PORT ?? 5199}`,
    // Match the local production fixture's certificate policy. Context-only
    // permission can still leave Chromium subresources failing TLS retries.
    ...(process.env.E2E_SERVER === "build" ? { ignoreHTTPSErrors: true, launchOptions: { args: ["--ignore-certificate-errors"] } } : {}),
    // UI language follows the browser (Paraglide preferredLanguage); assertions use English text.
    locale: "en-US",
    // Ordinary scenarios intercept network requests. Worker lifecycle and
    // offline behavior are covered by the separate production suite.
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
