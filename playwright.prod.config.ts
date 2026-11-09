import { defineConfig, devices } from "@playwright/test";

// Browser tests of the production build with production settings: NODE_ENV=production, CSP, behind a TLS proxy (pnpm test:e2e:prod).
// e2e-prod/global-setup.ts prepares pnpm build, server startup and fake SMTP. Separate from the development-server pnpm test:e2e setup; verifies UI operation under CSP
// with nonce-loaded scripts and no CSP console violations. E2E_PROD_PG=1 plus TEST_DATABASE_URL enables real PostgreSQL.
// Setup determines baseURL after choosing a port; tests read it from E2E_PROD_STATE through e2e-prod/helpers.ts.
export default defineConfig({
  testDir: "./e2e-prod",
  globalSetup: "./e2e-prod/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["./scripts/browser-reporter.ts"]],
  use: {
    ignoreHTTPSErrors: true,
    locale: "en-US",
    trace: "retain-on-failure",
  },
  // --ignore-certificate-errors: Chromium rejects service-worker registration with a self-signed TLS proxy certificate as an SSL certificate error when only ignoreHTTPSErrors is set.
  projects: [{ name: "chromium-production", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--ignore-certificate-errors"] } } }],
});
