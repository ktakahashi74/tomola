import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { distribution, formatHistory, historyMain, readHistory, summarizeHistory } from "../scripts/check-history.mjs";
import { validationMetadata } from "../scripts/check.mjs";
import PostgresSkipReporter, { FAILURE_LIMIT } from "../scripts/pg-skip-reporter.mjs";
import BrowserReporter from "../scripts/browser-reporter.ts";
import { metadataText } from "../scripts/check-metadata.ts";
import { selectFocused } from "../scripts/focused-checks.mjs";

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "check-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const browserTest = (status, extra = {}) => ({ file: "e2e/view.spec.ts", line: 42, title: "suite > reads", status, retry: 0, durationMs: 40, ...extra });
const browserStep = (status = "passed", durationMs = 100, tests = [browserTest(status)]) => ({ name: "browser", exitCode: status === "passed" ? 0 : 1, durationMs, browser: { mode: "private", tests } });
const run = (extra = {}) => ({ mode: "integration", status: "passed", input: "same", startedAt: "2026-01-02T00:00:00Z", steps: [browserStep()], unrun: [], quarantineRecovered: 0, ...extra });
const unitStep = unit => ({ name: "unit", exitCode: 0, durationMs: 20, unit });

test("wait metadata accepts nonnegative safe integers and omits absent or malformed values", () => {
  assert.deepEqual(validationMetadata({}), {});
  assert.deepEqual(validationMetadata({ TOMOLA_VALIDATE_MODE: "serial", TOMOLA_VALIDATE_AVAILABLE_GIB: "0", TOMOLA_VALIDATE_SLICE_GIB: "0" }), { availableGiB: 0, sliceGiB: 0, mode: "serial" });
  assert.deepEqual(validationMetadata({ TOMOLA_VALIDATE_LOCK_WAIT_MS: "0", TOMOLA_VALIDATE_OLD_LOCK_WAIT_MS: "12", TOMOLA_VALIDATE_MEMORY_WAIT_MS: "9876", TOMOLA_VALIDATE_AVAILABLE_GIB: "35", TOMOLA_VALIDATE_SLICE_GIB: "7", TOMOLA_VALIDATE_MODE: "parallel", TOMOLA_VALIDATE_SERIAL: "1", E2E_SERIAL: "0", SECRET_VALUE: "private" }), { lockWaitMs: 0, oldLockWaitMs: 12, memoryWaitMs: 9876, availableGiB: 35, sliceGiB: 7, forcedSerial: true, e2eSerial: false, mode: "parallel" });
  for (const value of ["", "-1", "1.1", "1e3", " 2", "2\n", "NaN", "Infinity", "9007199254740992", 4]) {
    assert.deepEqual(validationMetadata({ TOMOLA_VALIDATE_LOCK_WAIT_MS: value, TOMOLA_VALIDATE_OLD_LOCK_WAIT_MS: value, TOMOLA_VALIDATE_MEMORY_WAIT_MS: value, TOMOLA_VALIDATE_AVAILABLE_GIB: value, TOMOLA_VALIDATE_SLICE_GIB: value, TOMOLA_VALIDATE_MODE: value, TOMOLA_VALIDATE_SERIAL: value, E2E_SERIAL: value }), {});
  }
});

test("unit reporter records bounded test identities, collection failures and skips without error bodies", t => {
  const root = temporary(t), destination = path.join(root, "report.json");
  const previous = process.env.TOMOLA_CHECK_PG_REPORT;
  t.after(() => previous === undefined ? delete process.env.TOMOLA_CHECK_PG_REPORT : process.env.TOMOLA_CHECK_PG_REPORT = previous);
  process.env.TOMOLA_CHECK_PG_REPORT = destination;
  const reporter = new PostgresSkipReporter();
  reporter.onInit({ config: { root } });
  const cases = Array.from({ length: FAILURE_LIMIT + 3 }, (_, index) => ({ fullName: `suite > case ${index}`, tags: [], result: () => ({ state: "failed", errors: [{ message: "PRIVATE ERROR BODY" }] }), diagnostic: () => ({ duration: index + 1 }) }));
  cases.push(...Array.from({ length: FAILURE_LIMIT + 1 }, (_, index) => ({ fullName: `suite > skipped ${index}`, tags: ["postgres"], result: () => ({ state: "skipped" }) })));
  const module = { moduleId: path.join(root, "tests/unit.test.ts"), children: { allTests: () => cases }, errors: () => [], state: () => "failed", diagnostic: () => ({ duration: 99 }) };
  reporter.onTestRunEnd([module, ...Array.from({ length: FAILURE_LIMIT + 2 }, () => ({ ...module, moduleId: path.join(root, "tests/collection.test.ts"), children: { allTests: () => [] }, errors: () => [{ message: "PRIVATE ERROR BODY" }] }))]);
  const report = JSON.parse(fs.readFileSync(destination, "utf8"));
  assert.equal(report.postgresSkipped, FAILURE_LIMIT + 1);
  assert.equal(report.unit.files[0].skippedCount, FAILURE_LIMIT + 1);
  assert.ok(!("skipped" in report.unit.files[0]));
  assert.ok(!JSON.stringify(report).includes("suite > skipped"));
  assert.equal(report.unit.failureCount, FAILURE_LIMIT + 3);
  assert.equal(report.unit.failures.length, FAILURE_LIMIT);
  assert.equal(report.unit.failures[0].file, "tests/unit.test.ts");
  assert.equal(report.unit.failures[0].title, "suite > case 0");
  assert.equal(report.unit.failures[0].status, "failed");
  assert.equal(report.unit.failures[0].durationMs, 1);
  assert.equal(report.unit.collectionFailureCount, FAILURE_LIMIT + 2);
  assert.equal(report.unit.collectionFailures.length, FAILURE_LIMIT);
  assert.ok(!JSON.stringify(report).includes("PRIVATE ERROR BODY"));
  assert.ok(!JSON.stringify(report).includes(root));
});

test("browser reporter writes declaration line and redacts private identity metadata", t => {
  const root = temporary(t), destination = path.join(root, "browser.json"), previous = process.env.TOMOLA_BROWSER_REPORT;
  t.after(() => previous === undefined ? delete process.env.TOMOLA_BROWSER_REPORT : process.env.TOMOLA_BROWSER_REPORT = previous);
  process.env.TOMOLA_BROWSER_REPORT = destination;
  const reporter = new BrowserReporter();
  reporter.onBegin({ configFile: path.join(root, "playwright.config.ts"), metadata: {} });
  const testCase = { parent: { type: "file", location: { file: path.join(root, "e2e/view.spec.ts") } }, location: { file: path.join(root, "e2e/view.spec.ts"), line: 73 }, annotations: [], titlePath: () => ["project", "suite", "reads member@example.invalid /tmp/private-source"] };
  reporter.onTestEnd(testCase, { status: "passed", retry: 0, duration: 14 });
  reporter.onTestEnd({ ...testCase, location: { file: path.join(root, "e2e/helper.ts"), line: 12 } }, { status: "passed", retry: 0, duration: 14 });
  reporter.onEnd({ status: "passed" });
  const report = JSON.parse(fs.readFileSync(destination, "utf8"));
  assert.equal(report.tests[0].file, "e2e/view.spec.ts");
  assert.equal(report.tests[0].line, 73);
  assert.equal(report.tests[0].title, "suite > reads [email] [path]");
  assert.equal(report.tests[1].file, "e2e/view.spec.ts");
  assert.equal(report.tests[1].line, null);
});

test("metadata redacts drive paths at a left boundary without changing PostgreSQL URL schemes", () => {
  const title = "postgres:// and postgresql:// URLs";
  assert.equal(metadataText(title), title);
  assert.equal(metadataText(String.raw`loads C:\private\file and d:/private/file`), "loads [path] and [path]");
});

test("streaming reader joins starts across files, treats old rows as finished and counts malformed long lines", async t => {
  const root = temporary(t), first = path.join(root, "a.jsonl"), second = path.join(root, "b.jsonl");
  const start = { event: "started", runId: "one", mode: "integration", commit: "abc", startedAt: "2026-01-02T00:00:00Z" };
  fs.writeFileSync(first, [start, { ...start, runId: "stopped" }, run(), null, { mode: "integration", startedAt: start.startedAt, status: "passed", steps: [null] }].map(JSON.stringify).join("\n") + "\n{broken\n");
  fs.writeFileSync(second, JSON.stringify(run({ runId: "one", extra: "x".repeat(110000) })) + "\n");
  const summary = await readHistory([first, second]);
  assert.equal(summary.malformedLines, 3);
  assert.equal(summary.totalRuns, 3);
  assert.equal(summary.modes[0].passed, 2);
  assert.equal(summary.modes[0].interrupted, 1);
  const duplicated = await readHistory([first, path.join(root, ".", "a.jsonl"), first, second]);
  assert.equal(duplicated.totalRuns, summary.totalRuns);
  assert.equal(duplicated.malformedLines, summary.malformedLines);
  assert.equal(duplicated.filesRead, 2);
  assert.equal((await readHistory([first, second], { since: "2026-01-03" })).totalRuns, 0);
  assert.equal((await readHistory([first], { mode: "docs" })).totalRuns, 0);
  assert.match(formatHistory(summary), /malformed lines skipped: 3/);
  assert.equal(JSON.parse(await historyMain([first, second, "--json", "--mode=integration"])).totalRuns, 3);
  await assert.rejects(historyMain([first, "--since=invalid"]));
  await assert.rejects(historyMain([first, "--mode="]));
  const help = await historyMain(["--help"]);
  assert.match(help, /Date-only --since values use midnight UTC/);
  assert.match(help, /Prefer a timestamp with a timezone/);
  assert.match(help, /fail and then pass on retry within the same run/);
  assert.equal(JSON.parse(await historyMain([first, "--since=2026-01-02", "--json"])).totalRuns, 3);
  assert.equal(JSON.parse(await historyMain([first, "--since=2026-01-02T00:00:01Z", "--json"])).totalRuns, 0);
});

test("pass rates distinguish initial passes, quarantine recovery, stale and interrupted runs", () => {
  const summary = summarizeHistory([run(), run({ quarantineRecovered: 1 }), run({ status: "failed" }), run({ status: "stale" }), run({ status: "interrupted", steps: [] })]);
  assert.equal(summary.modes[0].firstAttempt.rate, 1 / 5);
  assert.equal(summary.modes[0].includingQuarantine.rate, 2 / 5);
  assert.equal(summary.modes[0].excludingInterrupted.firstAttempt.rate, 1 / 4);
  assert.equal(summary.modes[0].excludingInterrupted.includingQuarantine.rate, 2 / 4);
  assert.equal(summary.modes[0].excludingInterrupted.firstAttempt.total, 4);
  assert.equal(summary.repeatedInputRates[0].inputs, 1);
  assert.equal(summary.repeatedInputRates[0].firstAttempt.rate, 1 / 5);
  assert.equal(summary.repeatedInputRates[0].excludingInterrupted.firstAttempt.rate, 1 / 4);
  assert.match(formatHistory(summary), /all runs: first attempt 1\/5/);
  assert.match(formatHistory(summary), /excluding interrupted \(stale retained\): first attempt 1\/4/);
  const stopped = summarizeHistory([run({ status: "interrupted", steps: [] })]);
  assert.equal(stopped.modes[0].excludingInterrupted.firstAttempt.rate, null);
  const unique = summarizeHistory([run({ input: 'unique-one' }), run({ input: 'unique-two' })]);
  assert.equal(unique.repeatedInputRates[0].firstAttempt.rate, null);
});

test("flaky candidates require the same fingerprint and browser mode, preserving retries and declaration identity", () => {
  const failed = run({ status: "failed", steps: [browserStep("failed")] });
  assert.equal(summarizeHistory([failed, run({ input: "different" })]).unstableCandidates.length, 0);
  assert.equal(summarizeHistory([failed, run({ steps: [browserStep("passed", 100, [browserTest("passed", { line: 43 })])] })]).unstableCandidates.length, 0);
  assert.equal(summarizeHistory([failed, run({ steps: [{ ...browserStep(), browser: { mode: "public", tests: [browserTest("passed")] } }] })]).unstableCandidates.length, 0);
  const summary = summarizeHistory([failed, run(), run({ quarantineRecovered: 1, steps: [browserStep("passed", 100, [browserTest("failed"), browserTest("passed", { retry: 1 })])] })]);
  assert.equal(summary.unstableCandidates.length, 1);
  assert.equal(summary.unstableCandidates[0].failedRuns, 2);
  assert.equal(summary.unstableCandidates[0].passedRuns, 2);
  assert.equal(summary.topFailures[0].failedRuns, 2);
});

test("unit candidates require successful execution of the failed title, excluding skips, missing evidence and other backends", () => {
  const failure = { file: "tests/unit.test.ts", title: "suite > case", status: "failed", durationMs: 3 };
  const failed = run({ status: "failed", steps: [unitStep({ failures: [failure] })] });
  const passed = run({ steps: [unitStep({ files: [{ file: failure.file, status: "passed", skippedCount: 0, pendingCount: 0 }] })] });
  assert.equal(summarizeHistory([failed, passed]).unstableCandidates.length, 1);
  for (const counts of [{ skippedCount: 1, pendingCount: 0 }, { skippedCount: 0, pendingCount: 1 }, { pendingCount: 0 }]) {
    const other = run({ steps: [unitStep({ files: [{ file: failure.file, status: "passed", ...counts }] })] });
    assert.equal(summarizeHistory([failed, other]).unstableCandidates.length, 0);
  }
  const legacy = run({ steps: [unitStep({ files: [{ file: failure.file, status: "passed", skipped: ["other title"], skippedCount: 1, pendingCount: 0 }] })] });
  assert.equal(summarizeHistory([failed, legacy]).unstableCandidates.length, 1);
  for (const other of [run({ steps: [unitStep({})] }), run({ steps: [unitStep({ files: [{ file: failure.file, status: "passed", skipped: [failure.title], skippedCount: 1, pendingCount: 0 }] })] }), run({ steps: [{ ...passed.steps[0], settings: { TOMOLA_TEST_PG: "1" } }] })]) assert.equal(summarizeHistory([failed, other]).unstableCandidates.length, 0);
});

test("runs without browser stages have no browser execution mode, including older serial records", () => {
  for (const mode of ["docs", "fast", "focused"]) {
    const summary = summarizeHistory([run({ mode, browserExecution: "serial", steps: [unitStep({})] })]);
    assert.equal(summary.timings.steps[0].execution, "none");
    assert.equal(summary.timings.groups.length, 0);
  }
});

test("timings exclude incomplete and stale runs and split serial and parallel samples", () => {
  const complete = Array.from({ length: 10 }, (_, index) => run({ steps: [browserStep("passed", (index + 1) * 10)], validation: { lockWaitMs: (index + 1) * 100 } }));
  const summary = summarizeHistory([...complete,
    run({ status: "failed", steps: [browserStep("failed", 99999)], unrun: ["production"] }),
    run({ status: "stale", steps: [browserStep("passed", 88888)] }),
    run({ browserExecution: "parallel", steps: [{ name: "parallel browser", exitCode: 0, durationMs: 22, groups: [browserStep("passed", 20)] }] }),
  ]);
  const serial = summary.timings.steps.find(row => row.execution === "serial");
  assert.equal(serial.count, 10);
  assert.equal(serial.medianMs, 55);
  assert.equal(serial.p90Ms, 90);
  assert.equal(summary.timings.groups.find(row => row.execution === 'parallel').count, 1);
  assert.equal(summary.timings.browserFiles.find(row => row.execution === "serial").count, 10);
  assert.equal(summary.waits[0].medianMs, 550);
  assert.equal(summary.waits[0].p90Ms, 900);
  assert.deepEqual(distribution([]), { count: 0, medianMs: null, p90Ms: null });
});

test("selection diagnostics explain fallbacks without changing the selected result", t => {
  const root = temporary(t);
  for (const file of ["tests/unit.test.ts", "e2e/view.spec.ts", "app/lib/value.ts"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "");
  }
  const unknown = Array.from({ length: 25 }, (_, index) => `asset-${index}.json`), diagnostics = {};
  assert.deepEqual(selectFocused(root, unknown, diagnostics), selectFocused(root, unknown));
  assert.equal(diagnostics.reasons[0].count, 25);
  assert.equal(diagnostics.reasons[0].files.length, 20);
  const product = {};
  assert.deepEqual(selectFocused(root, ["app/lib/value.ts"], product).unit, ["tests/unit.test.ts"]);
  assert.ok(product.reasons.some(row => row.reason === "product-change-without-unit-match"));
});

test("actual Vitest reporting propagates failed tests and collection failures into the stage record", async t => {
  const root = temporary(t), destination = path.join(root, "unit.json");
  const vitest = new URL("../node_modules/vitest/dist/index.js", import.meta.url).pathname;
  fs.writeFileSync(path.join(root, "vitest.config.mjs"), 'export default { test: { include: ["*.test.mjs"], maxWorkers: 1, fileParallelism: false } };');
  fs.writeFileSync(path.join(root, "failure.test.mjs"), `import {test, expect} from ${JSON.stringify(vitest)}; test("safe failing title", () => expect(1).toBe(2));`);
  fs.writeFileSync(path.join(root, "collection.test.mjs"), 'throw new Error("PRIVATE COLLECTION BODY");');
  const result = spawnSync(process.execPath, [new URL("../node_modules/vitest/vitest.mjs", import.meta.url).pathname, "run", "--config", path.join(root, "vitest.config.mjs"), "--reporter", new URL("../scripts/pg-skip-reporter.mjs", import.meta.url).pathname], { cwd: root, env: { ...process.env, TOMOLA_CHECK_PG_REPORT: destination }, encoding: "utf8", timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(fs.existsSync(destination), result.stdout + result.stderr);
  const report = JSON.parse(fs.readFileSync(destination, "utf8"));
  assert.equal(report.unit.failureCount, 1);
  assert.equal(report.unit.failures[0].title, "safe failing title");
  assert.ok(report.unit.collectionFailures.some(row => row.file === "collection.test.mjs"));
  assert.ok(!JSON.stringify(report).includes("PRIVATE COLLECTION BODY"));
});
