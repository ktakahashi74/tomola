import { spawn, spawnSync } from "node:child_process";
import { changedFiles, selectFocused } from "./focused-checks.mjs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAST_TEST_FILES } from "../tests/fast-files.ts";
import { browserPorts, browserGroupCount } from "./browser-groups.ts";
import { cleanupBrowserRuns, collectBrowserArtifacts, createBrowserWorkspace, removeBrowserWorkspace } from "./browser-workspaces.mjs";
import { launchInValidationBudget } from "./check-resources.mjs";

const modes = ["docs", "fast", "focused", "integration", "release"];
const step = (name, args, env = {}) => ({ name, command: "pnpm", args, env });
const runnerTests = { name: "check runner", command: "node", args: ["--test", "--test-isolation=none", "tests/check-runner.test.mjs"], env: {} };
const lint = { name: "lint baseline", command: "node", args: ["scripts/check-lint.mjs"], env: {} };
const disclosure = { name: "disclosure baseline", command: "node", args: ["scripts/check-disclosure.mjs"], env: {} };
const bundleSize = { name: "page JavaScript budget", command: "node", args: ["scripts/check-bundle-size.mjs"], env: {} };
const isBrowserCheck = check => check.command === "pnpm" && (check.args[0]?.startsWith("test:e2e") || check.args[0] === "exec" && check.args[1] === "playwright");
const hasBrowserChecks = check => isBrowserCheck(check) || Boolean(check.parallel?.some(isBrowserCheck));

export function planChecks(argv, root, environment = process.env) {
  const [mode, ...options] = argv;
  if (!modes.includes(mode)) throw new Error(`Choose a check mode: ${modes.join(", ")}`);
  const dryRun = options.includes("--dry-run");
  const pg = options.includes("--pg");
  const changed = options.includes("--changed");
  const base = options.find(option => option.startsWith("--base="));
  if (base && !changed) throw new Error("--base requires --changed");
  const explicit = options.filter(value => !["--dry-run", "--pg", "--changed", base].includes(value));
  if (changed && (mode !== "focused" || explicit.length)) throw new Error("--changed is only for focused checks without explicit files");
  const diagnostics = {};
  const changedInputs = changed ? changedFiles(root, base?.slice(7) ?? "origin/main", diagnostics) : [];
  const selection = changed ? selectFocused(root, changedInputs, diagnostics) : null;
  const files = selection?.unit ?? explicit;
  if ((files.length || pg) && mode !== "focused") throw new Error("Only focused checks accept test files and --pg");
  if (mode === "focused" && !files.length && !changed) throw new Error("focused requires explicit tests/*.test.ts files; it never falls back to all tests");
  for (const file of files) {
    if (!file.startsWith("tests/") || !file.endsWith(".test.ts") || file.includes("\\") || path.posix.normalize(file) !== file || !fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error("Specify existing tests/*.test.ts files, without extra flags");
    }
  }
  if (pg || mode === "release") {
    let url;
    try { url = new URL(environment.TEST_DATABASE_URL ?? ""); } catch { /* Report no credentials. */ }
    if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
      throw new Error("TEST_DATABASE_URL must name a dedicated PostgreSQL test account that can create disposable databases");
    }
  }
  const full = step("unit (PGlite)", ["exec", "vitest", "run", "--maxWorkers=6"]);
  const fullPg = step("unit (PostgreSQL)", ["exec", "vitest", "run", "--config", "vitest.db.config.ts", "--maxWorkers=6"], { TOMOLA_TEST_PG: "1" });
  const units = { name: "unit (PGlite and PostgreSQL)", command: "parallel", args: [], env: {}, parallel: [full, fullPg] };
  const releaseUnits = environment.TOMOLA_VALIDATE_MODE === "parallel" ? [units] : [full, fullPg];
  const count = browserGroupCount(environment.E2E_GROUPS);
  const buildEnv = { E2E_SERVER: "build" };
  const publicBrowser = step("browser (public reading)", ["exec", "playwright", "test", "-c", "playwright.public.config.ts"], buildEnv);
  const ports = ["integration", "release"].includes(mode) && environment.E2E_SERIAL !== "1" ? browserPorts(environment.E2E_PORT, count) : null;
  const browserChecks = ports ? [{
    name: "browser (build and public reading)", command: "parallel", args: [], env: buildEnv,
    parallel: Object.entries(ports).map(([group, port]) => ({
      ...step(group === "public" ? "browser (public reading)" : `browser (private ${group.toUpperCase()})`,
        ["exec", "playwright", "test", ...(group === "public" ? ["-c", "playwright.public.config.ts"] : []), "--workers=1"],
        { ...buildEnv, E2E_PORT: port, E2E_BROWSER_GROUP: group, E2E_GROUPS: String(count) }), group,
    })),
  }] : [step("browser (build)", ["test:e2e"], buildEnv), publicBrowser];
  const focused = files.length ? [step("focused unit", ["exec", "vitest", "run", "--config", !pg && files.every(file => FAST_TEST_FILES.includes(file)) ? "vitest.fast.config.ts" : "vitest.config.ts", ...files], pg ? { TOMOLA_TEST_PG: "1" } : {})] : [];
  if (selection?.browser.length) {
    // Browser scenarios exercise routes over HTTP, so retain both authority modes.
    const specs = selection.browser.map(file => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    focused.push(step("focused browser (private)", ["exec", "playwright", "test", "--pass-with-no-tests", ...specs]));
    focused.push(step("focused browser (public)", ["exec", "playwright", "test", "-c", "playwright.public.config.ts", "--pass-with-no-tests", ...specs]));
  }
  if (selection?.production?.length) {
    const specs = selection.production.map(file => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    focused.push(step("focused browser (production)", ["exec", "playwright", "test", "-c", "playwright.prod.config.ts", "--pass-with-no-tests", ...specs], pg ? { E2E_PROD_PG: "1" } : {}));
  }
  const plans = {
    docs: [disclosure, step("documentation", ["exec", "vitest", "run", "--config", "vitest.fast.config.ts", "tests/documentation.test.ts"])],
    fast: [runnerTests, lint, step("no-DB unit", ["exec", "vitest", "run", "--config", "vitest.fast.config.ts", "--maxWorkers=4"])],
    focused,
    integration: [runnerTests, lint, disclosure, step("typecheck", ["typecheck"]), full, step("build", ["build"]), bundleSize, ...browserChecks],
    release: [runnerTests, lint, disclosure, step("typecheck", ["typecheck"]), ...releaseUnits, step("build", ["build"]), bundleSize, ...browserChecks,
      step("browser (production PostgreSQL)", ["test:e2e:prod"], { E2E_PROD_SKIP_BUILD: "1", E2E_PROD_PG: "1" }),
      step("migration metadata", ["exec", "drizzle-kit", "check"])],
  };
  return { mode, dryRun, options: [...(changed ? ["--changed", ...(base ? [base] : [])] : files), ...(pg ? ["--pg"] : [])], steps: plans[mode], ...(selection ? { selection: {
    ...diagnostics, changedFileCount: changedInputs.length, ...(changedInputs.length <= 500 ? { changedFiles: changedInputs } : {}),
    unit: selection.unit, browser: selection.browser, production: selection.production ?? [], all: selection.all,
  } } : {}) };
}

export function checkEnvironment(environment, overrides) {
  const env = { ...environment };
  for (const name of Object.keys(env)) {
    if (/_API_KEY$/.test(name) || name.startsWith("LLM_PRICE_")) env[name] = "";
  }
  for (const name of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "SMTP_URL", "MAIL_FROM", "MAIL_DECOY_TO", "DATABASE_URL", "TEST_DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "PGLITE_DATA_DIR", "TOMOLA_TEST_PG", "E2E_PROD_PG", "E2E_PROD_SKIP_BUILD", "E2E_BASE_URL", "OPERATOR_EMAILS", "ENABLED_LANGS", "PREVIEW_LANGS", "TRANSLATION_BACKFILL_ENABLED", "TRANSLATION_PRIMARY", "TRANSLATION_SECONDARY", "I18N_MODEL", "EMBEDDING_ENGINE", "E2E_BROWSER_GROUP", "E2E_BROWSER_OUTPUT", "E2E_STATE", "E2E_PROD_STATE", "TOMOLA_VITE_CACHE_DIR"]) env[name] = "";
  // Browser setup uses nullish defaults; empty paths would bypass those defaults.
  delete env.E2E_DATA_ROOT;
  delete env.E2E_PROD_DATA_ROOT;
  for (const name of ["E2E_BROWSER_OUTPUT", "E2E_STATE", "E2E_PROD_STATE", "TOMOLA_VITE_CACHE_DIR", "E2E_SERVER", "E2E_GROUPS", "E2E_ENABLED_LANGS", "E2E_PREVIEW_LANGS"]) delete env[name];
  delete env.NODE_ENV;
  delete env.TOMOLA_BROWSER_REPORT;
  delete env.TOMOLA_BROWSER_COMPLETE;
  if (overrides.TOMOLA_TEST_PG === "1" || overrides.E2E_PROD_PG === "1") env.TEST_DATABASE_URL = environment.TEST_DATABASE_URL;
  return { ...env, ...overrides };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("Could not inspect verification inputs with git");
  return result.stdout;
}

function gitState(root) {
  return { commit: git(root, ["rev-parse", "HEAD"]).trim(), dirty: Boolean(git(root, ["status", "--porcelain", "--untracked-files=normal"]).trim()) };
}

// Include tracked and new nonignored inputs; never follow a source symlink outside the checkout.
export function inputFingerprint(root) {
  const hash = createHash("sha256");
  const skip = ["app/paraglide", "app/lib/i18n/review-counts.generated.json", "project.inlang/cache", "project.inlang/.lix", "project.inlang/.meta.json", "project.inlang/README.md", "project.inlang/.gitignore"];
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  for (const relative of [...new Set(files)].sort()) {
    if (skip.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`)) || /(^|\/)\.env(?:$|\.(?!example$))/.test(relative)) continue;
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    const kind = !stat ? "missing" : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "directory";
    const contents = !stat ? Buffer.alloc(0) : stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : stat.isFile() ? fs.readFileSync(absolute) : Buffer.alloc(0);
    hash.update(`${relative}\0${kind}\0${stat ? stat.mode & 0o111 : 0}\0${contents.length}\0`);
    hash.update(contents);
  }
  return hash.digest("hex");
}

function standardMode(plan, root, environment) {
  try {
    const canonical = planChecks([plan.mode, ...(plan.options ?? [])], root, environment);
    return JSON.stringify(plan.steps) === JSON.stringify(canonical.steps) ? plan.mode : null;
  } catch { return null; }
}

async function execute(check, root, env) {
  let directory, output;
  const vitest = check.command === "pnpm" && check.args[0] === "exec" && check.args[1] === "vitest";
  const browser = isBrowserCheck(check);
  const browserReport = browser ? path.join(root, ".data/checks", `browser-results-${randomUUID()}.json`) : null;
  if (browserReport) env = { ...env, TOMOLA_BROWSER_REPORT: browserReport, TOMOLA_BROWSER_COMPLETE: check.name.startsWith("focused") ? "0" : "1" };
  const pgReport = vitest ? path.join(root, ".data/checks", `pg-skips-${randomUUID()}.json`) : null;
  const args = vitest ? [...check.args, "--reporter=default", "--reporter=./scripts/pg-skip-reporter.mjs"] : check.args;
  if (pgReport) env = { ...env, TOMOLA_CHECK_PG_REPORT: pgReport };
  try {
    if (check.group) {
      directory = createBrowserWorkspace(root, check.group, env);
      env = { ...env, E2E_DATA_ROOT: path.join(root, ".data", "checks", "browser-data", path.basename(directory)), E2E_BROWSER_OUTPUT: path.join(root, ".data", "checks", "browser-output", path.basename(directory)), TOMOLA_VITE_CACHE_DIR: path.join(directory, "node_modules", ".vite-e2e") };
      delete env.E2E_STATE;
      if (env.E2E_EVIDENCE_DIR) env.E2E_EVIDENCE_DIR = path.join(env.E2E_EVIDENCE_DIR, check.group);
    }
    if (check.logFile) output = fs.openSync(check.logFile, "w");
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(check.command, args, { cwd: directory ?? root, env, detached: Boolean(directory), stdio: output === undefined ? "inherit" : ["ignore", output, output] });
      const interrupt = (signal) => {
        if (!directory || child.pid === undefined) return;
        try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
      };
      const onInterrupt = () => interrupt("SIGINT"), onTerminate = () => interrupt("SIGTERM");
      if (directory) {
        process.on("SIGINT", onInterrupt);
        process.on("SIGTERM", onTerminate);
        child.once("close", () => {
          process.off("SIGINT", onInterrupt);
          process.off("SIGTERM", onTerminate);
        });
      }
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (browserReport) {
      const evidence = fs.existsSync(browserReport) ? JSON.parse(fs.readFileSync(browserReport, "utf8")) : null;
      return { exitCode: evidence && Array.isArray(evidence.tests) ? exitCode : exitCode || 1, browser: evidence };
    }
    if (!pgReport) return exitCode;
    const evidence = fs.existsSync(pgReport) ? JSON.parse(fs.readFileSync(pgReport, "utf8")) : null;
    return { exitCode, postgresSkipped: evidence?.postgresSkipped ?? null, ...(evidence?.unit ? { unit: evidence.unit } : {}) };
  } finally {
    if (pgReport) fs.rmSync(pgReport, { force: true });
    if (output !== undefined) fs.closeSync(output);
    if (directory) {
      try { collectBrowserArtifacts(root, directory, check.group, env); }
      finally { removeBrowserWorkspace(directory); }
    }
  }
}

function recoveredQuarantined(browser) {
  const cases = new Map();
  const rows = Array.isArray(browser?.tests) ? browser.tests : [];
  for (const row of rows) {
    if (!row?.quarantine || typeof row.file !== "string" || typeof row.title !== "string") continue;
    const key = JSON.stringify([row.file, row.title]);
    const state = cases.get(key) ?? { failed: false, recovered: false };
    if (row.retry === 0 && ["failed", "timedOut", "interrupted"].includes(row.status)) state.failed = true;
    if (row.retry === 1 && row.status === "passed" && state.failed) state.recovered = true;
    cases.set(key, state);
  }
  return [...cases.values()].filter(state => state.recovered).length;
}

export function validationMetadata(environment) {
  const result = {};
  for (const [name, field] of [
    ["TOMOLA_VALIDATE_LOCK_WAIT_MS", "lockWaitMs"],
    ["TOMOLA_VALIDATE_OLD_LOCK_WAIT_MS", "oldLockWaitMs"],
    ["TOMOLA_VALIDATE_MEMORY_WAIT_MS", "memoryWaitMs"],
    ["TOMOLA_VALIDATE_AVAILABLE_GIB", "availableGiB"],
    ["TOMOLA_VALIDATE_SLICE_GIB", "sliceGiB"],
  ]) {
    const value = environment[name];
    if (typeof value === "string" && value.length > 0 && !/[^0-9]/.test(value) && Number.isSafeInteger(Number(value))) result[field] = Number(value);
  }
  for (const [name, field] of [["TOMOLA_VALIDATE_SERIAL", "forcedSerial"], ["E2E_SERIAL", "e2eSerial"]]) {
    if (["0", "1"].includes(environment[name])) result[field] = environment[name] === "1";
  }
  if (["parallel", "serial"].includes(environment.TOMOLA_VALIDATE_MODE)) result.mode = environment.TOMOLA_VALIDATE_MODE;
  return result;
}

export async function runChecks(plan, root, environment = process.env, executor = execute, logger = console) {
  cleanupBrowserRuns(root);
  const report = { runId: randomUUID(), mode: plan.mode, standardMode: standardMode(plan, root, environment), ...gitState(root), postgresSkipped: 0, postgresSkippedInPglite: 0, quarantineRecovered: 0, input: inputFingerprint(root), startedAt: new Date().toISOString(), status: "running", steps: [],
    validation: validationMetadata(environment), browserExecution: plan.steps.some(check => check.parallel?.some(isBrowserCheck)) ? "parallel" : plan.steps.some(isBrowserCheck) ? "serial" : "none",
    ...(plan.selection ? { selection: plan.selection } : {}),
  };
  const destination = path.join(root, ".data/checks/latest.json");
  const save = () => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  };
  save();
  const history = path.join(root, ".data/checks/history.jsonl");
  fs.appendFileSync(history, `${JSON.stringify({ event: "started", runId: report.runId, mode: report.mode, commit: report.commit, input: report.input, startedAt: report.startedAt, validation: report.validation, browserExecution: report.browserExecution })}\n`);
  const recordOutcome = (detail, check, outcome) => {
    detail.exitCode = typeof outcome === "number" ? outcome : outcome.exitCode;
    if (typeof outcome === "object") {
      if (outcome.postgresSkipped !== undefined) detail.postgresSkipped = outcome.postgresSkipped;
      if (outcome.unit) detail.unit = outcome.unit;
      if (outcome.browser) detail.browser = outcome.browser;
    }
    if (Number.isInteger(detail.postgresSkipped)) {
      if (check.env.TOMOLA_TEST_PG === "1") report.postgresSkipped += detail.postgresSkipped;
      else report.postgresSkippedInPglite += detail.postgresSkipped;
    }
    if (plan.mode === "release" && check.env.TOMOLA_TEST_PG === "1" && detail.postgresSkipped !== 0) {
      detail.exitCode = 1;
      logger.error("[check] PostgreSQL tests were skipped, or skip evidence is missing");
    }
  };
  let built = false;
  let exitCode = 0;
  for (const check of plan.steps) {
    const started = Date.now();
    const result = { name: check.name, command: [check.command, ...check.args], settings: check.env,
      ...(hasBrowserChecks(check) ? { browserServer: check.env.E2E_SERVER === "build" ? "build" : check.args.includes("test:e2e:prod") || check.args.includes("playwright.prod.config.ts") ? "production" : "development" } : {}) };
    report.steps.push(result);
    try {
      if ((check.env.E2E_PROD_SKIP_BUILD || check.env.E2E_SERVER === "build") && (!built || !["build/server/index.js", "build/markdown/markdown-worker.mjs"].every(file => fs.existsSync(path.join(root, file))))) {
        throw new Error("Production browser checks need the successful build from this invocation");
      }
      logger.log(`\n[check] ${check.name}`);
      if (check.parallel) {
        result.groups = check.parallel.map(child => ({ name: child.name, command: [child.command, ...child.args], settings: child.env }));
        const logs = path.join(root, ".data", "checks", hasBrowserChecks(check) ? "browser-logs" : "unit-logs", `${report.startedAt.replace(/[^\d]/g, "")}-${process.pid}`);
        fs.mkdirSync(logs, { recursive: true });
        fs.writeFileSync(path.join(logs, "owner.pid"), String(process.pid));
        // Drain every child even if logging or artifact collection fails for one group.
        const outcomes = await Promise.allSettled(check.parallel.map(async (child, index) => {
          const detail = result.groups[index], groupStarted = Date.now();
          detail.exitCode = 1;
          detail.log = path.relative(root, path.join(logs, `${report.startedAt.replace(/[^\d]/g, "")}-${child.group ?? index}.log`));
          const logFile = path.join(root, detail.log);
          logger.log(`[check] ${child.name} started`);
          try {
            const outcome = await executor({ ...child, logFile }, root, checkEnvironment(environment, child.env));
            recordOutcome(detail, child, outcome);
          }
          catch { detail.exitCode = 1; logger.error(`[check] Could not complete ${child.name}`); }
          detail.durationMs = Date.now() - groupStarted;
          save();
          logger.log(`\n[check] ${child.name}: exit ${detail.exitCode}\n${fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""}`);
        }));
        for (const [index, outcome] of outcomes.entries()) {
          if (outcome.status === "rejected") result.groups[index].exitCode = 1;
        }
        result.exitCode = result.groups.find(group => group.exitCode !== 0)?.exitCode ?? 0;
      } else {
        const outcome = await executor(check, root, checkEnvironment(environment, check.env));
        recordOutcome(result, check, outcome);
      }
    } catch {
      // Child output is inherited; do not copy environment or credential-bearing errors into reports.
      logger.error(`[check] Could not complete ${check.name}`);
      result.exitCode = 1;
    }
    if (result.groups) {
      for (const group of result.groups) group.quarantineRecovered = recoveredQuarantined(group.browser);
      result.quarantineRecovered = result.groups.reduce((sum, group) => sum + group.quarantineRecovered, 0);
    } else if (result.browser) result.quarantineRecovered = recoveredQuarantined(result.browser);
    report.quarantineRecovered += result.quarantineRecovered ?? 0;
    result.durationMs = Date.now() - started;
    if (result.exitCode !== 0) {
      report.status = "failed";
      exitCode = result.exitCode;
    } else if (inputFingerprint(root) !== report.input) {
      report.status = "stale";
      logger.error("[check] Inputs changed during the run. Results are not a final verification.");
      exitCode = 2;
    }
    save();
    if (exitCode !== 0) break;
    if (check.name === "build") built = true;
  }
  if (!exitCode) report.status = "passed";
  report.finishedAt = new Date().toISOString();
  report.unrun = plan.steps.slice(report.steps.length).map((check) => check.name);
  save();
  fs.appendFileSync(history, `${JSON.stringify(report)}\n`);
  logger.log(`[check] ${report.status}: ${report.quarantineRecovered} quarantined test(s) recovered on retry`);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    const plan = planChecks(process.argv.slice(2), root);
    if (plan.dryRun) console.log(JSON.stringify(plan, null, 2));
    else {
      const scoped = await launchInValidationBudget([process.execPath, ...process.argv.slice(1)]);
      process.exitCode = scoped ?? await runChecks(plan, root);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
