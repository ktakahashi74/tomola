import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type FullConfig } from "@playwright/test";
import { assertPortFree, cleanupOnSignals, removeStaleDirs } from "./support";
import { waitForClientRoute } from "./helpers";
import { browserServerEnvironment } from "../scripts/browser-resources.mjs";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { startBuildServices } from "./build-services";

// E2E setup: create a temporary PGlite directory, seed it and start the selected server against it
// with a fake translation engine; read magic links from server stdout. Stop the server and remove the directory when done.
// PGlite cannot open the same data from multiple processes. Start sequentially here, seed first, rather than using Playwright webServer.
export default async function globalSetup(config: FullConfig) {
  const root = config.configFile ? path.dirname(config.configFile) : process.cwd();
  process.env.E2E_PUBLIC_READING = config.metadata.publicReading ? "1" : "";
  // Playwright applies the CLI repeat override to projects after global setup.
  const { values } = parseArgs({ args: process.argv.slice(2), options: { "repeat-each": { type: "string" } }, strict: false, allowPositionals: true });
  process.env.E2E_REPEAT_EACH = String(values["repeat-each"] ?? Math.max(1, ...config.projects.map(project => project.repeatEach)));
  const port = Number(process.env.E2E_PORT ?? 5199);
  const buildServer = process.env.E2E_SERVER === "build";
  const baseURL = `${buildServer ? "https" : "http"}://localhost:${port}`;
  if (buildServer && !fs.existsSync(path.join(root, "build/server/index.js"))) throw new Error("E2E_SERVER=build needs pnpm build first");
  // Some environments have a small tmpfs at /tmp; use the untracked .data directory under the repository.
  const dataRoot = process.env.E2E_DATA_ROOT ?? path.join(root, ".data");
  fs.mkdirSync(dataRoot, { recursive: true });
  // Clean directories left by earlier runs, such as forced termination; preserve E2E_KEEP directories marked .keep. Check that the port is free
  // so setup cannot accidentally connect to a leftover development server on the same port.
  removeStaleDirs(dataRoot, "e2e-");
  await assertPortFree(port);
  const dir = fs.mkdtempSync(path.join(dataRoot, "e2e-dev-"));
  fs.writeFileSync(path.join(dir, "owner.pid"), String(process.pid));
  const logFile = path.join(dir, "server.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR || path.join(root, "tests/fixtures/operator"),
    // Ordinary E2E needs the development language policy, including incomplete
    // interface translations. The separate e2e-prod suite checks production gates.
    NODE_ENV: buildServer ? "test" : "development",
    PGLITE_DATA_DIR: path.join(dir, "pglite"),
    BETTER_AUTH_URL: baseURL,
    BETTER_AUTH_SECRET: buildServer ? randomBytes(24).toString("hex") : "",
    // Fake translation engine only, no secondary engine or judge; no network access.
    TRANSLATION_PRIMARY: "fake",
    TRANSLATION_SECONDARY: "none",
    DIVERGENCE_JUDGE: "none",
    GEMINI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    // Development mail stays in stdout; build runs replace this with local fake SMTP below.
    SMTP_URL: "",
    MAIL_FROM: "",
    MAIL_DECOY_TO: "",
    // Fake embeddings for semantic search produce similar vectors across languages without network access.
    EMBEDDING_ENGINE: "fake",
    // hana is an operator for /admin/metrics; olga operates the moderation tests (e2e/moderation.spec.ts); gwen operates glossary tests (e2e/glossary.spec.ts).
    OPERATOR_EMAILS: "invite_bulk_operator@example.com,zresult_wide_mod@example.com,zresult_narrow_mod@example.com,vi_operator@example.com,vi_reviewer@example.com,av_operator@example.com,av_reviewer@example.com,dn_operator@example.com,hana@example.com,olga@example.com,gwen@example.com,opal@example.com,mobile@example.com,navigation_operator@example.com,ai_readiness_operator@example.com" + (config.metadata.publicReading ? ",vr_operator@example.com,vr_reviewer@example.com,crflow_op@example.com" : ""),
    WORKER_ENABLED: "true",
    MAINTENANCE_FLAG_FILE: path.join(dir, "maintenance"),
    REVISION: "0123456789abcdef0123456789abcdef01234567",
    CHAT_TRANSLATION_MODEL: "",
    CHAT_TRANSLATION_THINKING: "off",
    CHAT_TRANSLATION_CONCURRENCY: "4",
    CHAT_LLM_MONTHLY_BUDGET_USD: "2",
    // Exercise optional figure translation with fake engines in both reading modes.
    FIGURE_TRANSLATION: "1",
    FIGURE_READING_MODEL: "",
    MODERATION_SPAM_ENABLED: "",
    MODERATION_AI_SPAM_ENABLED: "",
    MODERATION_AI_TRIAGE_ENABLED: "",
    MODERATION_AI_MODEL: "",
    // Default to all nine languages; scoped language tests can explicitly override their server configuration.
    ENABLED_LANGS: process.env.E2E_ENABLED_LANGS ?? "",
    PREVIEW_LANGS: process.env.E2E_PREVIEW_LANGS ?? "",
    PUBLIC_READING: process.env.E2E_PUBLIC_READING ?? "",
    VILLAGES: config.metadata.publicReading ? "1" : "",
    VILLAGE_CHAT: config.metadata.publicReading ? "1" : "",
    POST_ASK_AI: "1",
    // Shorten the immediate-notification delay (production default: five minutes); e2e/moderation.spec.ts waits for mail.
    NOTIFICATION_EMAIL_DELAY_SECONDS: "1",
    // Configure one upstream proxy. Tests supply a client address in X-Forwarded-For (clientHeaders in e2e/helpers.ts).
    TRUSTED_PROXY_HOPS: "1",
    // The footer's link to the source code (e2e/principles.spec.ts). The production-build run (e2e-prod) leaves it unset and checks that no source link appears.
    SOURCE_URL: "https://example.org/tomola-source",
    // Keep Vite's dependency optimization cache in a dedicated E2E location. Sharing node_modules/.vite with a developer's server in the same worktree
    // would cause mutual reoptimization and page reloads. Reuse it across runs to avoid repeated optimization and mid-test reloads.
    // At startup, Vite rebuilds the cache if the lockfile or configuration changed.
    TOMOLA_VITE_CACHE_DIR: process.env.TOMOLA_VITE_CACHE_DIR ?? path.join(root, "node_modules", ".vite-e2e"),
  };
  delete env.DATABASE_URL;
  if (buildServer) Object.assign(env, {
    PORT: String(port + 1), HOST: "127.0.0.1",
    SMTP_URL: `smtp://127.0.0.1:${port + 2}`,
    MAIL_FROM: "tomola <no-reply@localhost>", MAIL_DECOY_TO: "decoy@example.invalid",
    TOMOLA_ALLOW_FAKE_ENGINES: "1",
  });

  // Prepare the development output before Vite can serve a request. A cold
  // project's metadata and locale-module generation otherwise reload SSR after
  // its global Markdown executor has already been created.
  if (process.env.E2E_BROWSER_GROUP && !buildServer) {
    const generated = spawnSync("pnpm", ["exec", "paraglide-js", "compile", "--project", "./project.inlang", "--outdir", "./app/paraglide", "--emit-ts-declarations", "--output-structure", "locale-modules", "--strategy", "custom-htmlLang", "baseLocale"], { cwd: root, env, encoding: "utf8" });
    if (generated.status !== 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`e2e locale preparation failed:\n${generated.stdout}\n${generated.stderr}`);
    }
  }
  const seedStarted = performance.now();
  // Seed the same complete fake fixtures even when the server under test has a paused budget.
  const seeded = spawnSync("pnpm", ["exec", "tsx", "e2e/seed.ts"], { cwd: root, env: { ...env, LLM_MONTHLY_BUDGET_USD: "20" }, encoding: "utf8" });
  if (seeded.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`e2e seed failed:\n${seeded.stdout}\n${seeded.stderr}`);
  }
  console.log(`Browser fixtures seeded in ${((performance.now() - seedStarted) / 1000).toFixed(2)}s`);
  const [invite, machineInvite, authInvite, moderationInvite, i18nInvite, questionsInvite, stancesInvite, glossaryInvite, scenarioInvite, scenarioOperatorInvite, followsInvite, mentionsInvite, discoveryAkiInvite, discoveryBenInvite, signingInvite, mcpInvite, mobileInvite, enrollmentInvite, languageInvite, navigationInvite, detectInvite, fallbackInvite, loginConfirmInvite, loginPromptInvite, loginUnsupportedInvite, loginCodeInvite, loginMcpInvite, loginFlowInvite, returnReaderInvite, returnWriterInvite, aiDraftInvite, loginPolishInvite, entryHeaderInvite, titleFirstInvite] = seeded.stdout.trim().split("\n").slice(-34);

  const out = fs.openSync(logFile, "a");
  const serverClock = path.join(dir, "server-clock.txt");
  fs.writeFileSync(serverClock, "0");
  let services: Awaited<ReturnType<typeof startBuildServices>> | undefined;
  try {
    services = buildServer ? await startBuildServices({ dir, logFile, port }) : undefined;
  } catch (error) {
    fs.closeSync(out);
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const server: ChildProcess = spawn(buildServer ? "node" : "pnpm", buildServer ? ["server.ts"] : ["exec", "react-router", "dev", "--port", String(port)], {
    cwd: root,
    env: { ...browserServerEnvironment(env), E2E_SERVER_CLOCK: serverClock, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.join(root, "e2e/server-clock.mjs")).href} --import=${pathToFileURL(path.join(root, "e2e/markdown-runtime.mjs")).href} --import=${pathToFileURL(path.join(root, "e2e/fake-translation-runtime.mjs")).href}` },
    stdio: ["ignore", out, out],
    detached: true,
  });
  if (server.pid !== undefined) fs.writeFileSync(path.join(dir, "server.pid"), String(server.pid));
  const retainServerLog = () => {
    if (!process.env.E2E_BROWSER_OUTPUT || !fs.existsSync(logFile)) return;
    fs.mkdirSync(process.env.E2E_BROWSER_OUTPUT, { recursive: true });
    fs.copyFileSync(logFile, path.join(process.env.E2E_BROWSER_OUTPUT, "server.log"));
  };
  const stop = () => {
    if (server.pid === undefined) return;
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  };
  process.once("exit", stop);
  // On interruption such as Ctrl-C, stop the server and remove the directory before exiting.
  const interrupted = async () => {
    stop();
    for (let i = 0; i < 30 && server.exitCode === null && server.signalCode === null; i++) await new Promise((r) => setTimeout(r, 100));
    if (server.pid !== undefined && server.exitCode === null && server.signalCode === null) {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
    await services?.close();
    retainServerLog();
    if (!process.env.E2E_KEEP) fs.rmSync(dir, { recursive: true, force: true });
  };
  const releaseSignals = cleanupOnSignals(interrupted);

  try {
    // Concurrent servers build independent cold module caches while sharing CPU.
    // Keep the original startup limit for sequential runs; test timeouts stay unchanged.
    const deadline = Date.now() + (process.env.E2E_BROWSER_GROUP ? 240_000 : 120_000);
    for (;;) {
      if (server.exitCode !== null) throw new Error(`browser server exited early:\n${fs.readFileSync(logFile, "utf8")}`);
      try {
        const res = await fetch(buildServer ? `http://127.0.0.1:${port + 1}/login` : `${baseURL}/login`, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) break;
      } catch {
        // Not ready yet.
      }
      if (Date.now() > deadline) throw new Error(`browser server did not start:\n${fs.readFileSync(logFile, "utf8")}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    // Open a browser page once beforehand: on its first load Vite discovers client dependencies, reoptimizes and reloads the page.
    // This keeps that reload out of the tests.
    const browser = await chromium.launch(buildServer ? { args: ["--ignore-certificate-errors"] } : {});
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: buildServer });
      // The passkey client is dynamically imported when its button is pressed. Import its dependencies (better-auth/client, etc.) beforehand here
      // so Vite optimizes them before the tests and does not reload a page midway through a test.
      for (let attempt = 0; ; attempt++) {
        // The listener can be ready before the cold client modules finish compiling.
        await page.goto(`${baseURL}/login`, { timeout: Math.max(1, deadline - Date.now()) });
        await waitForClientRoute(page);
        if (buildServer) break;
        try {
          await page.evaluate(async modulePath => { await import(/* @vite-ignore */ modulePath); }, "/app/lib/auth/client.ts");
          break;
        } catch (error) {
          if (attempt >= 2 || !(error instanceof Error) || !/Execution context was destroyed/.test(error.message)) throw error;
          // Dependency discovery can reload the page during its first import.
          // Reload and finish that preparation before any test starts.
        }
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    releaseSignals();
    await interrupted();
    throw error;
  }

  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ dir, baseURL, logFile, invite, machineInvite, authInvite, moderationInvite, i18nInvite, questionsInvite, stancesInvite, glossaryInvite, scenarioInvite, scenarioOperatorInvite, followsInvite, mentionsInvite, discoveryAkiInvite, discoveryBenInvite, signingInvite, mcpInvite, mobileInvite, enrollmentInvite, languageInvite, navigationInvite, detectInvite, fallbackInvite, loginConfirmInvite, loginPromptInvite, loginUnsupportedInvite, loginCodeInvite, loginMcpInvite, loginFlowInvite, returnReaderInvite, returnWriterInvite, aiDraftInvite, loginPolishInvite, entryHeaderInvite, titleFirstInvite }));
  process.env.E2E_STATE = path.join(dir, "state.json");

  return async () => {
    releaseSignals();
    stop();
    // Wait for server exit and release of the PGlite lock before removing the directory.
    for (let i = 0; i < 50 && server.exitCode === null && server.signalCode === null; i++) await new Promise((r) => setTimeout(r, 100));
    if (server.exitCode === null && server.signalCode === null && server.pid !== undefined) {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
    // E2E_KEEP=1 preserves the logs and DB for debugging.
    await services?.close();
    retainServerLog();
    if (!process.env.E2E_KEEP) fs.rmSync(dir, { recursive: true, force: true });
    else {
      fs.writeFileSync(path.join(dir, ".keep"), "");
      console.log(`e2e data kept in ${dir}`);
    }
  };
}
