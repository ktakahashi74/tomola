import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const failedStates = new Set(["failed", "timedOut", "interrupted"]);
const finiteDuration = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

// Nearest rank makes p90 the slowest of ten samples; median interpolates the middle pair.
export function distribution(values) {
  const sorted = values.filter(finiteDuration).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, medianMs: null, p90Ms: null };
  const middle = Math.floor(sorted.length / 2);
  return { count: sorted.length, medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, p90Ms: sorted[Math.ceil(sorted.length * 0.9) - 1] };
}

function validRecord(row) {
  if (!row || typeof row !== "object" || typeof row.mode !== "string" || typeof row.startedAt !== "string" || !Number.isFinite(Date.parse(row.startedAt))) return false;
  if (row.event === "started") return typeof row.runId === "string" && row.runId.length > 0;
  return ["passed", "failed", "stale", "running"].includes(row.status) && Array.isArray(row.steps)
    && row.steps.every(step => step && typeof step === "object" && typeof step.name === "string"
      && (step.groups === undefined || Array.isArray(step.groups) && step.groups.every(group => group && typeof group.name === "string")));
}

export async function readHistory(files, { since, mode } = {}) {
  const starts = new Map(), endings = new Map(), legacy = [];
  let malformedLines = 0;
  files = [...new Set(files.map(file => path.resolve(file)))];
  for (const file of files) {
    const input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { malformedLines++; continue; }
        if (!validRecord(row)) { malformedLines++; continue; }
        if (row.event === "started") starts.set(row.runId, row);
        else if (row.runId) endings.set(row.runId, row);
        else legacy.push(row);
      }
    } finally { lines.close(); input.destroy(); }
  }
  const runs = [...legacy, ...endings.values(), ...[...starts.values()].filter(row => !endings.has(row.runId)).map(row => ({ ...row, status: "interrupted", steps: [] }))]
    .map(row => row.status === "running" ? { ...row, status: "interrupted" } : row)
    .filter(row => (!mode || row.mode === mode) && (!since || Date.parse(row.startedAt) >= Date.parse(since)));
  return summarizeHistory(runs, { malformedLines, filesRead: files.length });
}

const details = run => run.steps.flatMap(step => step.groups ?? [step]);
const rows = value => Array.isArray(value) ? value.filter(row => row && typeof row === "object") : [];
const browserMode = detail => detail.browser?.mode ?? (/public/i.test(detail.name) ? "public" : /production/i.test(detail.name) ? "production" : "private");
const execution = run => details(run).some(detail => detail.browser || /browser/i.test(detail.name))
  ? run.browserExecution ?? (run.steps.some(step => step.groups?.length) ? "parallel" : "serial") : "none";
const isComplete = run => ["passed", "failed"].includes(run.status) && (Array.isArray(run.unrun) ? run.unrun.length === 0 : run.status === "passed")
  && run.steps.every(step => Number.isInteger(step.exitCode) && finiteDuration(step.durationMs));

function testObservations(run) {
  const found = new Map();
  const observe = (identity, status) => {
    const key = JSON.stringify(identity), item = found.get(key) ?? { ...identity, failed: false, passed: false };
    if (failedStates.has(status) || status === "collection-failed") item.failed = true;
    if (status === "passed") item.passed = true;
    found.set(key, item);
  };
  for (const detail of details(run)) {
    for (const test of rows(detail.browser?.tests)) {
      if (typeof test.file !== "string" || typeof test.title !== "string") continue;
      observe({ kind: "browser", file: test.file, line: test.line ?? null, title: test.title, scope: browserMode(detail) }, test.status);
    }
    for (const test of rows(detail.unit?.failures)) {
      if (typeof test.file !== "string" || typeof test.title !== "string") continue;
      observe({ kind: "unit", file: test.file, title: test.title, scope: detail.settings?.TOMOLA_TEST_PG === "1" ? "PostgreSQL" : "PGlite" }, test.status);
    }
    for (const test of rows(detail.unit?.collectionFailures)) {
      if (typeof test.file === "string") observe({ kind: "collection", file: test.file, title: "[collection]", scope: detail.settings?.TOMOLA_TEST_PG === "1" ? "PostgreSQL" : "PGlite" }, "collection-failed");
    }
  }
  return found;
}

export function summarizeHistory(runs, extra = {}) {
  const modes = new Map(), failures = new Map(), candidates = new Map();
  const timings = { steps: new Map(), groups: new Map(), browserFiles: new Map() }, waits = new Map();
  const addTiming = (map, identity, value) => {
    if (!finiteDuration(value)) return;
    const key = JSON.stringify(identity), entry = map.get(key) ?? { ...identity, values: [] };
    entry.values.push(value); map.set(key, entry);
  };
  for (const run of runs) {
    const mode = modes.get(run.mode) ?? { mode: run.mode, total: 0, passed: 0, failed: 0, stale: 0, interrupted: 0, firstAttemptPassed: 0 };
    mode.total++; mode[run.status]++;
    if (run.status === "passed" && !(run.quarantineRecovered > 0)) mode.firstAttemptPassed++;
    modes.set(run.mode, mode);
    for (const field of ["lockWaitMs", "oldLockWaitMs", "memoryWaitMs"]) addTiming(waits, { name: field }, run.validation?.[field]);
    for (const [key, item] of testObservations(run)) {
      if (item.failed) {
        const entry = failures.get(key) ?? { kind: item.kind, file: item.file, ...(item.kind === "browser" ? { line: item.line } : {}), title: item.title, scope: item.scope, failedRuns: 0 };
        entry.failedRuns++; failures.set(key, entry);
      }
      if (typeof run.input !== "string" || !run.input || run.status === "stale") continue;
      const fingerprint = JSON.stringify([run.input, key]);
      const candidate = candidates.get(fingerprint) ?? { ...item, input: run.input, failedRuns: 0, passedRuns: 0 };
      if (item.failed) candidate.failedRuns++;
      if (item.passed) candidate.passedRuns++;
      candidates.set(fingerprint, candidate);
    }
    if (!isComplete(run)) continue;
    const parallelism = execution(run);
    for (const step of run.steps) {
      addTiming(timings.steps, { mode: run.mode, execution: parallelism, name: step.name }, step.durationMs);
      for (const group of step.groups ?? []) addTiming(timings.groups, { mode: run.mode, execution: parallelism, name: group.name }, group.durationMs);
      if (!step.groups && step.browser) addTiming(timings.groups, { mode: run.mode, execution: parallelism, name: step.name }, step.durationMs);
    }
    const files = new Map();
    for (const detail of details(run)) for (const test of rows(detail.browser?.tests)) {
      if (typeof test.file !== "string" || !finiteDuration(test.durationMs)) continue;
      const identity = { mode: run.mode, execution: parallelism, scope: browserMode(detail), file: test.file };
      const key = JSON.stringify(identity), entry = files.get(key) ?? { identity, total: 0 };
      entry.total += test.durationMs; files.set(key, entry);
    }
    for (const { identity, total } of files.values()) addTiming(timings.browserFiles, identity, total);
  }
  // Count-only reports prove title success only when no tests were skipped or pending.
  for (const candidate of candidates.values()) {
    if (!["unit", "collection"].includes(candidate.kind) || !candidate.failedRuns) continue;
    candidate.passedRuns = runs.filter(run => run.input === candidate.input && run.status !== "stale" && details(run).some(detail => {
      const scope = detail.settings?.TOMOLA_TEST_PG === "1" ? "PostgreSQL" : "PGlite";
      return scope === candidate.scope && rows(detail.unit?.files).some(file => file.file === candidate.file && file.status === "passed"
        && (candidate.kind === "collection" || file.pendingCount === 0 && (file.skippedCount === 0
          || Array.isArray(file.skipped) && file.skippedCount === file.skipped.length && !file.skipped.includes(candidate.title))));
    })).length;
  }
  const timedRows = map => [...map.values()].map(({ values, ...identity }) => ({ ...identity, ...distribution(values) })).sort((a, b) => b.p90Ms - a.p90Ms || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const repeatedInputs = new Map();
  for (const run of runs) {
    if (typeof run.input !== "string" || !run.input) continue;
    const key = JSON.stringify([run.mode, run.input]);
    const group = repeatedInputs.get(key) ?? [];
    group.push(run); repeatedInputs.set(key, group);
  }
  const repeatedInputRates = [...modes.keys()].sort().map(mode => {
    const groups = [...repeatedInputs.values()].filter(group => group[0].mode === mode && group.length > 1);
    const matched = groups.flat(), total = matched.length;
    const passed = matched.filter(run => run.status === "passed").length;
    const firstPassed = matched.filter(run => run.status === "passed" && !(run.quarantineRecovered > 0)).length;
    return { mode, inputs: groups.length, ...passRates(firstPassed, passed, total), excludingInterrupted: passRates(firstPassed, passed, total - matched.filter(run => run.status === "interrupted").length) };
  });
  return {
    ...extra, totalRuns: runs.length,
    modes: [...modes.values()].sort((a, b) => a.mode.localeCompare(b.mode)).map(({ firstAttemptPassed, ...mode }) => ({ ...mode,
      ...passRates(firstAttemptPassed, mode.passed, mode.total),
      excludingInterrupted: passRates(firstAttemptPassed, mode.passed, mode.total - mode.interrupted),
    })),
    repeatedInputRates,
    unstableCandidates: [...candidates.values()].filter(item => item.failedRuns && item.passedRuns).map(({ failed, passed, ...item }) => item),
    topFailures: [...failures.values()].sort((a, b) => b.failedRuns - a.failedRuns || a.file.localeCompare(b.file)).slice(0, 20),
    timings: Object.fromEntries(Object.entries(timings).map(([kind, map]) => [kind, timedRows(map)])), waits: timedRows(waits),
  };
}

function passRates(firstPassed, passed, total) {
  return { firstAttempt: { passed: firstPassed, total, rate: total ? firstPassed / total : null }, includingQuarantine: { passed, total, rate: total ? passed / total : null } };
}

export function formatHistory(summary) {
  const lines = [`Runs: ${summary.totalRuns}; malformed lines skipped: ${summary.malformedLines ?? 0}`];
  const rate = value => `${value.passed}/${value.total} (${value.rate === null ? "n/a" : `${(100 * value.rate).toFixed(1)}%`})`;
  const rates = mode => `all runs: first attempt ${rate(mode.firstAttempt)}, including quarantine ${rate(mode.includingQuarantine)}; excluding interrupted (stale retained): first attempt ${rate(mode.excludingInterrupted.firstAttempt)}, including quarantine ${rate(mode.excludingInterrupted.includingQuarantine)}`;
  for (const mode of summary.modes) lines.push(`${mode.mode}: passed=${mode.passed} failed=${mode.failed} stale=${mode.stale} interrupted=${mode.interrupted}; ${rates(mode)}`);
  for (const mode of summary.repeatedInputRates) lines.push(`${mode.mode} repeated inputs=${mode.inputs}: ${rates(mode)}`);
  for (const [label, entries] of [["Unstable candidates", summary.unstableCandidates], ["Top failures", summary.topFailures]]) {
    lines.push(`${label}: ${entries.length}`);
    for (const item of entries) lines.push(`  ${item.kind} ${item.file}${item.line ? `:${item.line}` : ""} ${item.title} [${item.scope}] failed=${item.failedRuns}${item.passedRuns ? ` passed=${item.passedRuns} input=${item.input}` : ""}`);
  }
  for (const [label, entries] of [...Object.entries(summary.timings), ["waits", summary.waits]]) {
    lines.push(`${label}:`);
    for (const item of entries) lines.push(`  ${[item.mode, item.execution, item.scope, item.name ?? item.file].filter(Boolean).join(" / ")}: n=${item.count} median=${item.medianMs}ms p90=${item.p90Ms}ms`);
  }
  return lines.join("\n");
}

export async function historyMain(args) {
  const usage = "Usage: node scripts/check-history.mjs <history.jsonl...> [--since=<date>] [--mode=<mode>] [--json]\nDate-only --since values use midnight UTC. Prefer a timestamp with a timezone, such as --since=2026-11-01T00:00:00+09:00.\nUnstable candidates include quarantined tests that fail and then pass on retry within the same run.";
  if (args.includes("--help")) return usage;
  const files = [], options = {};
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--since=")) {
      options.since = arg.slice(8);
      if (!Number.isFinite(Date.parse(options.since))) throw new Error("--since requires a valid date");
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice(7);
      if (!options.mode) throw new Error("--mode requires a check mode");
    } else if (arg.startsWith("--")) throw new Error("Unknown history option");
    else files.push(arg);
  }
  if (!files.length) throw new Error(usage);
  const summary = await readHistory(files, options);
  return json ? JSON.stringify(summary, null, 2) : formatHistory(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(await historyMain(process.argv.slice(2))); }
  catch { console.error("Could not read check history. Use --help for paths, options and date semantics."); process.exitCode = 1; }
}
