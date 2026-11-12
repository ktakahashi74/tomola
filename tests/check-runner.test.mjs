import "./quarantine-policy.test.mjs";
import "./check-tools.test.mjs";
import "./check-resources.test.mjs";
import "./check-history.test.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { checkEnvironment, inputFingerprint, planChecks, runChecks as executeChecks } from "../scripts/check.mjs";
import { cleanupBrowserRuns, collectBrowserArtifacts, createBrowserWorkspace, relocateDependencyShims, removeBrowserWorkspace } from "../scripts/browser-workspaces.mjs";

const runChecks = (plan, root, env, executor) => executeChecks(plan, root, env, executor, { log() {}, error() {} });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "tests/email.test.ts"), "// fixture\n");
  fs.writeFileSync(path.join(root, "email.test.ts"), "// outside the test directory\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".data\nnode_modules\nbuild\n");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: root }).status, 0);
  return root;
}
const readReport = (root) => JSON.parse(fs.readFileSync(path.join(root, ".data/checks/latest.json"), "utf8"));
const pgEnv = { TEST_DATABASE_URL: "postgres://test:secret@localhost/test", TOMOLA_VALIDATE_MODE: "parallel" };

test("records commit, dirty state, canonical modes and append-only history", async t => {
  const root = fixture(t), plan = planChecks(["docs"], root, {});
  await runChecks(plan, root, {}, async () => 0);
  const first = readReport(root);
  assert.match(first.commit, /^[a-f0-9]{40}$/);
  assert.equal(first.dirty, false);
  assert.equal(first.standardMode, "docs");
  assert.equal(first.browserExecution, "none");
  fs.appendFileSync(path.join(root, "tests/email.test.ts"), "// dirty\n");
  await runChecks({ ...plan, steps: [] }, root, {}, async () => 0);
  assert.equal(readReport(root).standardMode, null);
  assert.equal(readReport(root).dirty, true);
  const history = fs.readFileSync(path.join(root, ".data/checks/history.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(history.filter(row => row.event !== "started"), [first, readReport(root)]);
  assert.equal(history.length, 4);
  for (const index of [0, 2]) {
    assert.equal(history[index].event, "started");
    assert.equal(history[index].browserExecution, "none");
    assert.equal(history[index].runId, history[index + 1].runId);
  }
});

test("public files and the entrypoint invalidate a running result", async t => {
  const root = fixture(t);
  for (const file of ["public/sw.js", "docker-entrypoint.sh"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "before");
    assert.equal(await runChecks(planChecks(["docs"], root, {}), root, {}, async () => { fs.writeFileSync(path.join(root, file), "after"); return 0; }), 2);
  }
});

test("fingerprints distinguish deleted files, symlinks and executable modes", t => {
  const root = fixture(t), file = path.join(root, "tests/email.test.ts");
  fs.writeFileSync(file, "deleted");
  const present = inputFingerprint(root);
  fs.unlinkSync(file);
  assert.notEqual(inputFingerprint(root), present);
  fs.writeFileSync(file, "../email.test.ts");
  const regular = inputFingerprint(root);
  fs.unlinkSync(file); fs.symlinkSync("../email.test.ts", file);
  assert.notEqual(inputFingerprint(root), regular);
  fs.unlinkSync(file); fs.writeFileSync(file, "// executable fixture\n", { mode: 0o644 });
  const plain = inputFingerprint(root);
  fs.chmodSync(file, 0o755);
  assert.notEqual(inputFingerprint(root), plain);
});

test("release fails on skipped PostgreSQL tests and integration records them", async t => {
  const root = fixture(t);
  const pg = planChecks(["release"], root, pgEnv).steps.flatMap(s => s.parallel ?? [s]).find(s => s.env.TOMOLA_TEST_PG === "1");
  assert.equal(await runChecks({ mode: "release", steps: [pg] }, root, pgEnv, async () => ({ exitCode: 0, postgresSkipped: 1 })), 1);
  assert.equal(readReport(root).steps[0].postgresSkipped, 1);
  assert.equal(await runChecks({ mode: "integration", steps: [pg] }, root, {}, async () => ({ exitCode: 0, postgresSkipped: 3 })), 0);
  assert.equal(readReport(root).postgresSkipped, 3);
});

test("dependency relocation normalizes trailing separators and preserves unrelated prefixes", t => {
  const root = fixture(t), directory = path.join(root, "copy");
  fs.mkdirSync(path.join(directory, "node_modules/.bin"), { recursive: true });
  const file = path.join(directory, "node_modules/.bin/tool");
  fs.writeFileSync(file, `NODE_PATH=${root}/node_modules/tool\nother=${root}-other/node_modules/tool\n`);
  relocateDependencyShims(root + path.sep, directory + path.sep);
  assert.equal(fs.readFileSync(file, "utf8"), `NODE_PATH=${directory}/node_modules/tool\nother=${root}-other/node_modules/tool\n`);
});

test("cleanup reclaims interrupted copies and old evidence while protecting live owners and kept runs", t => {
  const root = fixture(t), now = Date.now();
  const make = (kind, name, owner, kept = false, old = true) => {
    const directory = path.join(root, ".data/checks", kind, name);
    fs.mkdirSync(directory, { recursive: true });
    if (owner) fs.writeFileSync(path.join(directory, "owner.pid"), String(owner));
    if (kept) fs.writeFileSync(path.join(directory, ".keep"), "");
    if (old) fs.utimesSync(directory, new Date(now - 8 * 86400000), new Date(now - 8 * 86400000));
    return directory;
  };
  const dead = Number(spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }).stdout.trim());
  const stale = make("browser-workspaces", "a-stale", dead);
  const legacy = make("browser-workspaces", "b-legacy");
  const active = make("browser-workspaces", "public-live", process.pid);
  const creating = make("browser-workspaces", "b-creating", undefined, false, false);
  const kept = make("browser-workspaces", "a-kept", dead, true);
  const oldUnitLog = make("unit-logs", "old", dead);
  const liveUnitLog = make("unit-logs", "live", process.pid);
  const oldArtifact = make("browser-artifacts", "a-old", dead);
  const liveArtifact = make("browser-artifacts", "b-live", process.pid);
  const recent = make("browser-artifacts", "a-recent", dead, false, false);
  const oldLog = make("browser-logs", "old-run", dead);
  const liveLog = make("browser-logs", "live-run", process.pid);
  cleanupBrowserRuns(root, { now });
  for (const directory of [stale, legacy, oldArtifact, oldLog, oldUnitLog]) assert.equal(fs.existsSync(directory), false, directory);
  for (const directory of [active, creating, kept, liveArtifact, recent, liveLog, liveUnitLog]) assert.equal(fs.existsSync(directory), true, directory);
});

for (const linked of [false, true]) test(`cleanup preserves an old unmarked copy used by a surviving server${linked ? " through a symlink root" : ""}`, async t => {
  if (process.platform !== "linux") return;
  const root = fixture(t), directory = path.join(root, ".data/checks/browser-workspaces/a-server");
  fs.mkdirSync(directory, { recursive: true });
  const suppliedRoot = linked ? path.join(root, "alias") : root;
  if (linked) fs.symlinkSync(root, suppliedRoot, "dir");
  const ready = path.join(root, "server-ready"), stop = path.join(root, "server-stop");
  const child = spawn(process.execPath, ["-e", `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},''); const timer=setInterval(() => { if(fs.existsSync(${JSON.stringify(stop)})) { clearInterval(timer); process.exit(0); } }, 20)`], { cwd: directory, stdio: "ignore" });
  const exited = once(child, "exit");
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready)) {
      assert.ok(Date.now() < deadline, "test server did not start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const old = new Date(Date.now() - 120000); fs.utimesSync(directory, old, old);
    cleanupBrowserRuns(suppliedRoot);
    assert.equal(fs.existsSync(directory), true);
  } finally { fs.writeFileSync(stop, ""); await exited; }
  cleanupBrowserRuns(suppliedRoot); assert.equal(fs.existsSync(directory), false);
});

test("cleanup tolerates a directory removed by another cleaner after enumeration", t => {
  const root = fixture(t), parent = path.join(root, ".data/checks/browser-workspaces");
  const disappearing = path.join(parent, "a-gone"), sibling = path.join(parent, "b-stale");
  for (const directory of [disappearing, sibling]) {
    fs.mkdirSync(directory, { recursive: true });
    const old = new Date(Date.now() - 120000); fs.utimesSync(directory, old, old);
  }
  const original = fs.lstatSync;
  try {
    fs.lstatSync = (file, ...args) => {
      if (file === disappearing) { fs.rmdirSync(file); throw Object.assign(new Error("Already removed"), { code: "ENOENT" }); }
      return original(file, ...args);
    };
    assert.doesNotThrow(() => cleanupBrowserRuns(root));
    assert.equal(fs.existsSync(sibling), false);
  } finally { fs.lstatSync = original; }
});

test("one environment switch preserves separate serial private and public build checks", (t) => {
  const root = fixture(t);
  for (const mode of ["integration", "release"]) {
    const steps = planChecks([mode], root, { ...pgEnv, E2E_SERIAL: "1" }).steps;
    const privateIndex = steps.findIndex(step => step.name === "browser (build)");
    assert.deepEqual(steps[privateIndex].args, ["test:e2e", "--forbid-only"]);
    assert.equal(steps[privateIndex + 1].name, "browser (public reading)");
    assert.deepEqual(steps[privateIndex + 1].args, ["exec", "playwright", "test", "--forbid-only", "-c", "playwright.public.config.ts"]);
  }
});

test("parallel browsers use three independent ports and one worker in every group", (t) => {
  const root = fixture(t);
  for (const mode of ["integration", "release"]) {
    const groups = planChecks([mode], root, { ...pgEnv, E2E_PORT: "5311", E2E_GROUPS: "3" }).steps.find(step => step.parallel?.some(child => child.group)).parallel;
    assert.deepEqual(groups.map(group => group.env.E2E_PORT), ["5311", "15311", "25311"]);
    assert.deepEqual(groups.map(group => group.env.E2E_BROWSER_GROUP), ["a", "b", "public"]);
    for (const group of groups) assert.deepEqual(group.args.slice(-1), ["--workers=1"]);
  }
});

test("integration and release configure each build group explicitly and sanitize focused development checks", t => {
  const root = fixture(t);
  for (const mode of ["integration", "release"]) for (const count of [3, 4, 5, 6]) {
    const groups = planChecks([mode], root, { ...pgEnv, E2E_GROUPS: String(count), E2E_PORT: "5446" }).steps.find(step => step.parallel?.some(child => child.group)).parallel;
    assert.equal(groups.length, count);
    assert.equal(groups.at(-1).group, "public");
    for (const group of groups) {
      assert.equal(group.env.E2E_SERVER, "build");
      assert.equal(group.env.E2E_GROUPS, String(count));
      assert.deepEqual(group.args.slice(-1), ["--workers=1"]);
    }
  }
  const inherited = { E2E_SERVER: "build", E2E_ENABLED_LANGS: "ja,en", E2E_PREVIEW_LANGS: "fr", E2E_GROUPS: "6" };
  const clean = checkEnvironment(inherited, {});
  for (const key of Object.keys(inherited)) assert.equal(clean[key], undefined);
  const plan = { mode: "focused", steps: [{ name: "focused browser", command: "pnpm", args: ["test:e2e"], env: {} }] };
  return runChecks(plan, root, inherited, async () => 0).then(() => assert.equal(readReport(root).steps[0].browserServer, "development"));
});

test("ordinary build groups cannot run before this pipeline builds, even with an older artifact", async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "build/server"), { recursive: true });
  fs.writeFileSync(path.join(root, "build/server/index.js"), "old build");
  fs.mkdirSync(path.join(root, "build/markdown"), { recursive: true });
  fs.writeFileSync(path.join(root, "build/markdown/markdown-worker.mjs"), "old worker build");
  const browser = planChecks(["integration"], root, {}).steps.find(step => step.parallel);
  let calls = 0;
  assert.equal(await runChecks({ mode: "integration", steps: [browser] }, root, {}, async () => { calls++; return 0; }), 1);
  assert.equal(calls, 0);
  const build = { name: "build", command: "pnpm", args: ["build"], env: {} };
  assert.equal(await runChecks({ mode: "integration", steps: [build, browser] }, root, {}, async () => 0), 0);
  assert.equal(readReport(root).steps.at(-1).browserServer, "build");
});

test("build workspaces copy existing output without linking mutable source artifacts", t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, "build/server"), { recursive: true });
  fs.writeFileSync(path.join(root, "build/server/index.js"), "original build");
  const directory = createBrowserWorkspace(root, "c", { E2E_SERVER: "build" });
  try {
    assert.equal(fs.readFileSync(path.join(directory, "build/server/index.js"), "utf8"), "original build");
    fs.writeFileSync(path.join(directory, "build/server/index.js"), "changed copy");
    assert.equal(fs.readFileSync(path.join(root, "build/server/index.js"), "utf8"), "original build");
  } finally { removeBrowserWorkspace(directory); }
});

test("browser workspaces isolate sources, generation, dependencies and kept data", (t) => {
  const root = fixture(t);
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n.data\nnode_modules\napp/paraglide\n");
  fs.writeFileSync(path.join(root, ".env"), "TEST_SECRET=never-copy\n");
  for (const file of ["node_modules/fixture/index.js", "app/paraglide/runtime.js"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "original");
  }
  fs.mkdirSync(path.join(root, "node_modules/.bin"));
  fs.writeFileSync(path.join(root, "node_modules/.bin/fixture"), `#!/bin/sh\nNODE_PATH="${root}/node_modules/fixture"\nexec node "$basedir/../fixture/index.js"\n# cmd-shim-target=${root}/node_modules/fixture/index.js\n`);
  const first = createBrowserWorkspace(root, "a"), second = createBrowserWorkspace(root, "b");
  try {
    assert.notEqual(first, second);
    assert.equal(fs.existsSync(path.join(first, ".env")), false);
    for (const directory of [first, second]) {
      const shim = fs.readFileSync(path.join(directory, "node_modules/.bin/fixture"), "utf8");
      assert.ok(shim.includes(`${directory}/node_modules/fixture`));
      assert.ok(!shim.includes(`${root}/node_modules/fixture`));
      assert.ok(shim.includes('$basedir/../fixture/index.js'));
    }
    assert.ok(fs.readFileSync(path.join(root, "node_modules/.bin/fixture"), "utf8").includes(`${root}/node_modules/fixture`));
    for (const file of ["tests/email.test.ts", "node_modules/fixture/index.js", "app/paraglide/runtime.js"]) {
      const original = fs.readFileSync(path.join(root, file), "utf8");
      fs.writeFileSync(path.join(first, file), "changed in A");
      assert.equal(fs.readFileSync(path.join(second, file), "utf8"), original);
      assert.equal(fs.readFileSync(path.join(root, file), "utf8"), original);
    }
    const data = path.join(root, ".data", "owned-data"), output = path.join(root, ".data", "owned-output");
    fs.mkdirSync(path.join(data, "e2e-dev-fixture"), { recursive: true });
    fs.writeFileSync(path.join(data, "e2e-dev-fixture/server.log"), "kept log");
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, "trace.zip"), "trace");
    fs.mkdirSync(path.join(first, ".data"));
    fs.writeFileSync(path.join(first, ".data/measurement.json"), '{"width":390}');
    const artifacts = collectBrowserArtifacts(root, first, "a", { E2E_DATA_ROOT: data, E2E_BROWSER_OUTPUT: output, E2E_KEEP: "1" });
    assert.equal(fs.existsSync(path.join(artifacts, ".keep")), true);
    removeBrowserWorkspace(first);
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.readFileSync(path.join(artifacts, "test-results/trace.zip"), "utf8"), "trace");
    assert.equal(fs.readFileSync(path.join(artifacts, "measurements/measurement.json"), "utf8"), '{"width":390}');
    assert.equal(fs.readFileSync(path.join(artifacts, "data/e2e-dev-fixture/server.log"), "utf8"), "kept log");
    assert.equal(fs.existsSync(data), false);
    assert.equal(fs.existsSync(output), false);
    assert.equal(fs.existsSync(path.join(artifacts, "tests/email.test.ts")), false);
  } finally {
    removeBrowserWorkspace(first);
    removeBrowserWorkspace(second);
  }
});

test("a failed browser group drains its siblings and keeps each group's output in a separate log", async (t) => {
  const root = fixture(t), loggerLines = [], seen = [];
  const groupStep = { ...planChecks(["integration"], root, { E2E_GROUPS: "3" }).steps.find(step => step.parallel), env: {} };
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let finished = false;
  const running = executeChecks({ mode: "integration", steps: [groupStep] }, root, {}, async check => {
    seen.push(check.group);
    fs.writeFileSync(check.logFile, `${check.group}: owned-test-result\n`);
    if (check.group === "b") await held;
    if (check.group === "public") throw new Error("artifact collection failed");
    return check.group === "a" ? 1 : 0;
  }, { log: text => loggerLines.push(text), error: text => loggerLines.push(text) }).then(exit => { finished = true; return exit; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ["a", "b", "public"]);
  assert.equal(finished, false);
  release();
  assert.equal(await running, 1);
  const report = readReport(root);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.steps[0].groups.map(group => group.exitCode), [1, 0, 1]);
  for (const group of report.steps[0].groups) assert.ok(fs.existsSync(path.join(root, group.log)));
  const output = loggerLines.filter(line => line.includes("owned-test-result"));
  assert.equal(output.length, 3);
  for (const section of output) assert.equal(section.split("owned-test-result").length, 2);
});

test("release checks the production build once on PostgreSQL", (t) => {
  const steps = planChecks(["release"], fixture(t), pgEnv).steps.filter(step => step.name.startsWith("browser (production"));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].name, "browser (production PostgreSQL)");
  assert.equal(steps[0].env.E2E_PROD_PG, "1");
  assert.equal(steps[0].env.E2E_PROD_SKIP_BUILD, "1");
});

test("focused requires explicit files and cannot accept traversal or arbitrary Vitest flags", (t) => {
  const root = fixture(t);
  for (const args of [[], ["../outside.test.ts"], ["tests/../email.test.ts"], ["--update"], ["tests/missing.test.ts"]]) {
    assert.throws(() => planChecks(["focused", ...args], root, {}));
  }
  const plan = planChecks(["focused", "tests/email.test.ts"], root, {});
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].args.at(-1), "tests/email.test.ts");
  assert.ok(plan.steps[0].args.includes("vitest.fast.config.ts"));
});

test("every planned unit and browser stage rejects exclusive tests independently of CI", t => {
  const root = fixture(t);
  for (const file of ["e2e/view.spec.ts", "e2e-prod/live.spec.ts"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "// browser fixture\n");
  }
  fs.appendFileSync(path.join(root, "tests/email.test.ts"), "// changed unit fixture\n");
  const invocations = [
    ["docs"], ["fast"], ["integration"], ["release"],
    ["focused", "tests/email.test.ts"], ["focused", "--pg", "tests/email.test.ts"],
    ["focused", "--changed", "--base=HEAD"], ["focused", "--pg", "--changed", "--base=HEAD"],
  ];
  for (const E2E_SERIAL of ["", "1"]) for (const TOMOLA_VALIDATE_MODE of ["serial", "parallel"]) {
    for (const args of invocations) {
      const plan = planChecks(args, root, { ...pgEnv, CI: "", E2E_SERIAL, TOMOLA_VALIDATE_MODE });
      const stages = plan.steps.flatMap(stage => stage.parallel ?? [stage]);
      const units = stages.filter(stage => stage.command === "pnpm" && stage.args[1] === "vitest");
      const browsers = stages.filter(stage => stage.command === "pnpm" && (stage.args[0].startsWith("test:e2e") || stage.args[1] === "playwright"));
      assert.ok(units.length > 0, args.join(" "));
      if (args.includes("--changed")) assert.equal(browsers.length, 3);
      if (["integration", "release"].includes(args[0])) assert.ok(browsers.length >= 2);
      for (const stage of units) assert.equal(stage.args.filter(arg => arg === "--allowOnly=false").length, 1, stage.name);
      for (const stage of browsers) assert.equal(stage.args.filter(arg => arg === "--forbid-only").length, 1, stage.name);
    }
  }
});

test("PostgreSQL checks fail preflight without a dedicated URL and do not disclose credentials", (t) => {
  const root = fixture(t);
  for (const env of [{}, { TEST_DATABASE_URL: "https://test:secret@example.com" }]) {
    assert.throws(() => planChecks(["release"], root, env), (error) => !error.message.includes("secret"));
    assert.throws(() => planChecks(["focused", "--pg", "tests/email.test.ts"], root, env));
  }
  assert.equal(fs.existsSync(path.join(root, ".data")), false);
  assert.equal(planChecks(["release"], root, pgEnv).mode, "release");
});

test("real keys, mail, database and inherited skip-build flags are cleared except explicit PG settings", () => {
  const inherited = { TEST_DATABASE_URL: pgEnv.TEST_DATABASE_URL, GEMINI_API_KEY: "secret", SMTP_URL: "smtp://real", DATABASE_URL: "postgres://production", E2E_PROD_SKIP_BUILD: "1", TOMOLA_TEST_PG: "1", LLM_PRICE_CUSTOM: "99" };
  const clean = checkEnvironment(inherited, {});
  for (const key of Object.keys(inherited)) assert.equal(clean[key], "", key);
  const pg = checkEnvironment(inherited, { TOMOLA_TEST_PG: "1" });
  assert.equal(pg.TEST_DATABASE_URL, pgEnv.TEST_DATABASE_URL);
  assert.equal(pg.DATABASE_URL, "");
});

test("browser data roots discard inherited overrides and allow the setup default", () => {
  const clean = checkEnvironment(Object.fromEntries(["E2E_DATA_ROOT", "E2E_PROD_DATA_ROOT", "E2E_BROWSER_OUTPUT", "TOMOLA_VITE_CACHE_DIR", "E2E_STATE", "E2E_PROD_STATE"].map(key => [key, "/inherited/path"])), {});
  for (const key of ["E2E_DATA_ROOT", "E2E_PROD_DATA_ROOT", "E2E_BROWSER_OUTPUT", "TOMOLA_VITE_CACHE_DIR", "E2E_STATE", "E2E_PROD_STATE"]) {
    assert.equal(clean[key], undefined, key);
    assert.equal(clean[key] ?? ".data", ".data", key);
  }
});

test("a failed step stops the pipeline and records the unfinished scope without secrets", async (t) => {
  const root = fixture(t);
  let calls = 0;
  const exit = await runChecks(planChecks(["release"], root, pgEnv), root, pgEnv, async () => { calls++; return 7; });
  assert.equal(exit, 7);
  assert.equal(calls, 1);
  const report = readReport(root);
  assert.equal(report.status, "failed");
  assert.ok(report.unrun.length > 0);
  assert.ok(!JSON.stringify(report).includes("secret"));
});

test("changes during a check invalidate the result and stop further steps", async (t) => {
  const root = fixture(t);
  let calls = 0;
  const exit = await runChecks(planChecks(["integration"], root, {}), root, {}, async () => {
    calls++;
    fs.appendFileSync(path.join(root, "tests/email.test.ts"), "// changed\n");
    return 0;
  });
  assert.equal(exit, 2);
  assert.equal(calls, 1);
  assert.equal(readReport(root).status, "stale");
});

test("Paraglide generation preserves verification inputs while project settings changes invalidate them", async (t) => {
  const root = fixture(t);
  const project = path.join(root, "project.inlang");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "settings.json"), '{"baseLocale":"en"}\n');
  const plan = planChecks(["docs"], root, {});
  const generated = ["cache/paraglide-js/generated.json", "cache/plugins/generated", ".lix/README.md", ".meta.json", "README.md", ".gitignore"];
  assert.equal(await runChecks(plan, root, {}, async () => {
    for (const file of generated) {
      const destination = path.join(project, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, "generated state\n");
    }
    return 0;
  }), 0);
  assert.equal(readReport(root).status, "passed");
  assert.equal(await runChecks(plan, root, {}, async () => {
    fs.writeFileSync(path.join(project, "settings.json"), '{"baseLocale":"ja"}\n');
    return 0;
  }), 2);
  assert.equal(readReport(root).status, "stale");
});

test("production checks reuse only a successful build from the same pipeline, with both artifacts present", async (t) => {
  const root = fixture(t);
  const plan = planChecks(["release"], root, pgEnv);
  const seen = [];
  const exit = await runChecks(plan, root, pgEnv, async (check, cwd, env) => {
    seen.push(check.name);
    if (check.name === "build") {
      fs.mkdirSync(path.join(cwd, "build/server"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "build/server/index.js"), "// built\n");
      fs.mkdirSync(path.join(cwd, "build/markdown"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "build/markdown/markdown-worker.mjs"), "// built worker\n");
    }
    if (check.name.startsWith("browser (production")) assert.equal(env.E2E_PROD_SKIP_BUILD, "1");
    return check.env.TOMOLA_TEST_PG === "1" ? { exitCode: 0, postgresSkipped: 0 } : 0;
  });
  assert.equal(exit, 0);
  assert.equal(seen.filter((name) => name === "build").length, 1);
  assert.equal(readReport(root).status, "passed");
  let unsafeCalls = 0;
  const unsafe = { mode: "release", steps: plan.steps.filter((check) => check.env.E2E_PROD_SKIP_BUILD) };
  assert.equal(await runChecks(unsafe, root, pgEnv, async () => { unsafeCalls++; return 0; }), 1);
  assert.equal(unsafeCalls, 0);
  fs.rmSync(path.join(root, "build"), { recursive: true });
  assert.equal(await runChecks(plan, root, pgEnv, async () => 0), 1);
  assert.equal(readReport(root).status, "failed");
});

test("build-backed browser checks stop when either server or Markdown worker output is missing", async t => {
  const root = fixture(t);
  const artifacts = ["build/server/index.js", "build/markdown/markdown-worker.mjs"];
  const release = planChecks(["release"], root, pgEnv);
  const serial = planChecks(["integration"], root, { E2E_SERIAL: "1" });
  const build = release.steps.find(check => check.name === "build");
  const browsers = [...release.steps, ...serial.steps].filter(check => check.env.E2E_PROD_SKIP_BUILD || check.env.E2E_SERVER === "build");
  for (const missing of artifacts) {
    for (const browser of browsers) {
      fs.rmSync(path.join(root, "build"), { recursive: true, force: true });
      let browserCalls = 0;
      assert.equal(await runChecks({ mode: "focused", steps: [build, browser] }, root, pgEnv, async check => {
        if (check === build) {
          for (const artifact of artifacts.filter(file => file !== missing)) {
            const file = path.join(root, artifact);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, "// built\n");
          }
        } else browserCalls++;
        return 0;
      }), 1, `${browser.name}: ${missing}`);
      assert.equal(browserCalls, 0);
      assert.equal(readReport(root).status, "failed");
    }
  }
});

test("integration and release check page JavaScript immediately after build and stop on an exceeded budget", async (t) => {
  const root = fixture(t);
  for (const mode of ["integration", "release"]) {
    const plan = planChecks([mode], root, pgEnv);
    const index = plan.steps.findIndex((check) => check.name === "build");
    const budget = plan.steps[index + 1];
    assert.equal(budget.command, "node");
    assert.deepEqual(budget.args, ["scripts/check-bundle-size.mjs"]);
    const seen = [];
    assert.equal(await runChecks(plan, root, pgEnv, async (check) => {
      seen.push(check.name);
      return check === budget ? 1 : check.env.TOMOLA_TEST_PG === "1" ? { exitCode: 0, postgresSkipped: 0 } : 0;
    }), 1);
    assert.equal(seen.at(-1), budget.name);
    assert.ok(!seen.some((name) => name.startsWith("browser")));
    assert.equal(readReport(root).status, "failed");
  }
});

test("release runs all PGlite files and only database files on PostgreSQL", (t) => {
  const plan = planChecks(["release"], fixture(t), pgEnv);
  const units = plan.steps.find(step => step.name === "unit (PGlite and PostgreSQL)").parallel;
  const pglite = units.find(step => step.name === "unit (PGlite)");
  const postgres = units.find(step => step.name === "unit (PostgreSQL)");
  assert.deepEqual(pglite.args, ["exec", "vitest", "run", "--allowOnly=false", "--maxWorkers=6"]);
  assert.deepEqual(postgres.args, ["exec", "vitest", "run", "--allowOnly=false", "--config", "vitest.db.config.ts", "--maxWorkers=6"]);
  assert.equal(postgres.env.TOMOLA_TEST_PG, "1");
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "tests/db-client.test.ts"), "// database fixture\n");
  for (const args of [["focused", "tests/email.test.ts", "tests/db-client.test.ts"], ["focused", "--pg", "tests/email.test.ts"]]) {
    assert.ok(!planChecks(args, root, pgEnv).steps[0].args.includes("vitest.fast.config.ts"));
  }
});

test("separates intentional PGlite skips from real PostgreSQL stage skips", async t => {
  const root = fixture(t);
  const plan = planChecks(["release"], root, pgEnv);
  const stages = plan.steps.filter(s => s.name.startsWith("unit"));
  assert.equal(await runChecks({ mode: "release", steps: stages }, root, pgEnv, async check => ({ exitCode: 0, postgresSkipped: check.env.TOMOLA_TEST_PG === "1" ? 0 : 143 })), 0);
  assert.equal(readReport(root).postgresSkipped, 0);
  assert.equal(readReport(root).postgresSkippedInPglite, 143);
});

test('lint and disclosure guard integration and release; fast mode lints and docs scans disclosure', t => {
  const root = fixture(t);
  for (const mode of ['integration', 'release']) {
    const names = planChecks([mode], root, pgEnv).steps.map(row => row.name);
    assert.ok(names.indexOf('lint baseline') < names.findIndex(name => name.startsWith('unit (')));
    assert.ok(names.includes('disclosure baseline'));
  }
  assert.ok(planChecks(['fast'], root, {}).steps.some(row => row.name === 'lint baseline'));
  assert.ok(planChecks(['docs'], root, {}).steps.some(row => row.name === 'disclosure baseline'));
});
test('focused changed selects only modified tests, and accepts an empty selection without a full-suite fallback', async t => {
  const root = fixture(t);
  assert.deepEqual(planChecks(['focused', '--changed', '--base=HEAD'], root, {}).steps, []);
  fs.appendFileSync(path.join(root, 'tests/email.test.ts'), '// changed\n');
  const plan = planChecks(['focused', '--changed', '--base=HEAD'], root, {});
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].args.at(-1), 'tests/email.test.ts');
  assert.equal(plan.selection.base, 'HEAD');
  assert.match(plan.selection.mergeBase, /^[a-f0-9]{40}$/);
  assert.deepEqual(plan.selection.changedFiles, ['tests/email.test.ts']);
  assert.deepEqual(plan.selection.unit, ['tests/email.test.ts']);
  await runChecks(plan, root, {}, async () => 0);
  assert.deepEqual(readReport(root).selection, plan.selection);
  assert.throws(() => planChecks(['focused', '--base=HEAD'], root, {}));
});

test('started evidence exists before execution, and unit and validation metadata reach the finished record', async t => {
  const root = fixture(t), unit = { failureCount: 1, failures: [{ file: 'tests/email.test.ts', title: 'suite > fails', status: 'failed', durationMs: 12 }] };
  await runChecks(planChecks(['focused', 'tests/email.test.ts'], root, {}), root, { TOMOLA_VALIDATE_LOCK_WAIT_MS: '12', TOMOLA_VALIDATE_MODE: 'serial', TOMOLA_VALIDATE_AVAILABLE_GIB: '18', TOMOLA_VALIDATE_SLICE_GIB: '9', E2E_SERIAL: '1' }, async () => {
    const start = fs.readFileSync(path.join(root, '.data/checks/history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(start.length, 1);
    assert.equal(start[0].event, 'started');
    assert.equal(start[0].runId, readReport(root).runId);
    return { exitCode: 1, postgresSkipped: 0, unit };
  });
  const report = readReport(root);
  assert.deepEqual(report.steps[0].unit, unit);
  assert.deepEqual(report.validation, { lockWaitMs: 12, availableGiB: 18, sliceGiB: 9, e2eSerial: true, mode: 'serial' });
  const history = fs.readFileSync(path.join(root, '.data/checks/history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(history[0].validation, report.validation);
  assert.deepEqual(history[1].validation, report.validation);
  assert.equal(report.validation.e2eSerial, true);
  assert.equal(report.browserExecution, 'none');
});

test('changed file evidence keeps at most 500 paths and retains the full count', t => {
  const root = fixture(t);
  for (let index = 0; index < 501; index++) fs.writeFileSync(path.join(root, `asset-${index}.json`), '{}');
  const plan = planChecks(['focused', '--changed', '--base=HEAD', '--dry-run'], root, {});
  assert.equal(plan.selection.changedFileCount, 501);
  assert.equal(plan.selection.changedFiles, undefined);
  assert.equal(plan.selection.all, true);
  assert.equal(plan.selection.reasons[0].files.length, 20);
  assert.equal(fs.existsSync(path.join(root, '.data')), false);
});
test('browser attempt evidence is retained for every parallel group', async t => {
  const root = fixture(t);
  const plan = planChecks(['integration'], root, { E2E_GROUPS: "3" });
  plan.steps = plan.steps.filter(row => row.parallel).map(row => ({ ...row, env: {} }));
  const evidence = { tests: [{ file: 'e2e/owned.spec.ts', retry: 1, status: 'passed', durationMs: 200, quarantine: 'known' }] };
  assert.equal(await runChecks(plan, root, {}, async () => ({ exitCode: 0, browser: evidence })), 0);
  assert.deepEqual(readReport(root).steps[0].groups.map(row => row.browser), [evidence, evidence, evidence]);
});

for (const parallel of [false, true]) for (const failed of [false, true]) {
  test(`summarizes recovered quarantined cases after ${parallel ? 'parallel' : 'serial'} checks, including ${failed ? 'failed' : 'passed'} runs`, async t => {
    const root = fixture(t), lines = [];
    const row = (title, status, retry, quarantine = 'known') => ({ file: 'e2e/owned.spec.ts', title, status, retry, durationMs: 1, quarantine });
    const evidence = { tests: [
      row('recovered', 'failed', 0), row('recovered', 'passed', 1), row('recovered', 'passed', 1),
      row('timed out', 'timedOut', 0), row('timed out', 'passed', 1),
      row('persistent', 'failed', 0), row('persistent', 'failed', 1),
      row('ordinary', 'failed', 0, null), row('ordinary', 'passed', 1, null),
      row('first pass', 'passed', 0), row('orphaned pass', 'passed', 1),
      row('skipped', 'failed', 0), row('skipped', 'skipped', 1),
    ] };
    const steps = parallel
      ? planChecks(['integration'], root, { E2E_GROUPS: "3" }).steps.filter(step => step.parallel).map(step => ({ ...step, env: {} }))
      : [{ name: 'browser fixture', command: 'pnpm', args: ['exec', 'playwright', 'test'], env: {} }];
    const expected = parallel ? 6 : 2;
    const exitCode = await executeChecks({ mode: 'integration', steps }, root, {}, async () => ({ exitCode: failed ? 1 : 0, browser: evidence }), { log: text => lines.push(text), error: text => lines.push(text) });
    assert.equal(exitCode, failed ? 1 : 0);
    const report = readReport(root);
    assert.equal(report.status, failed ? 'failed' : 'passed');
    assert.equal(report.quarantineRecovered, expected);
    assert.equal(report.steps[0].quarantineRecovered, expected);
    if (parallel) assert.deepEqual(report.steps[0].groups.map(group => group.quarantineRecovered), [2, 2, 2]);
    assert.match(lines.at(-1), new RegExp(`${expected} quarantined test\\(s\\) recovered on retry`));
    await executeChecks({ mode: 'integration', steps: [] }, root, {}, async () => 0, { log: text => lines.push(text), error() {} });
    assert.equal(readReport(root).quarantineRecovered, 0, 'counts belong to one invocation');
  });
}

test('invalid browser evidence keeps its failed record and contributes no recovered cases', async t => {
  const root = fixture(t);
  const plan = { mode: 'focused', steps: [{ name: 'browser fixture', command: 'pnpm', args: ['exec', 'playwright', 'test'], env: {} }] };
  for (const browser of [{ tests: {} }, { tests: [null] }, {}]) {
    assert.equal(await runChecks(plan, root, {}, async () => ({ exitCode: 1, browser })), 1);
    assert.equal(readReport(root).status, 'failed');
    assert.equal(readReport(root).quarantineRecovered, 0);
  }
});

import BrowserReporter from '../scripts/browser-reporter.ts';
test('direct Playwright records its development or build server without replacing a runner-owned record', t => {
  const root = fixture(t), saved = { E2E_SERVER: process.env.E2E_SERVER, TOMOLA_BROWSER_REPORT: process.env.TOMOLA_BROWSER_REPORT };
  try {
    for (const server of ['development', 'build']) {
      process.env.E2E_SERVER = server;
      delete process.env.TOMOLA_BROWSER_REPORT;
      const reporter = new BrowserReporter();
      reporter.onBegin({ configFile: path.join(root, 'playwright.prod-browser-switch.config.ts'), metadata: {} });
      assert.equal(readReport(root).status, 'running');
      reporter.onEnd({ status: 'passed', duration: 123 });
      const record = readReport(root);
      assert.equal(record.status, 'passed');
      assert.equal(record.standardMode, null);
      assert.equal(record.steps[0].browserServer, server);
      assert.equal(record.steps[0].browser.mode, 'private');
      assert.equal(record.input, inputFingerprint(root));
    }
    const before = fs.readFileSync(path.join(root, '.data/checks/latest.json'), 'utf8');
    process.env.TOMOLA_BROWSER_REPORT = path.join(root, '.data/checks/runner-browser.json');
    const reporter = new BrowserReporter();
    reporter.onBegin({ configFile: path.join(root, 'playwright.config.ts'), metadata: {} });
    reporter.onEnd({ status: 'passed', duration: 123 });
    assert.equal(fs.readFileSync(path.join(root, '.data/checks/latest.json'), 'utf8'), before);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

for (const failure of ["none", "pglite", "pg", "skipped", "missing", "rejected"]) {
  test(`parallel unit stages drain both backends and retain failure evidence: ${failure}`, { timeout: 3000 }, async t => {
    const root = fixture(t);
    const unit = planChecks(["release"], root, pgEnv).steps.find(s => s.name === "unit (PGlite and PostgreSQL)");
    const after = { name: "after units", command: "node", args: [], env: {} };
    const both = Promise.withResolvers();
    let started = 0, finished = 0, advanced = false;
    const code = await runChecks({ mode: "release", steps: [unit, after] }, root, pgEnv, async (check, cwd, env) => {
      if (check === after) { advanced = true; return 0; }
      const pg = check.env.TOMOLA_TEST_PG === "1";
      assert.equal(Boolean(env.TEST_DATABASE_URL), pg);
      if (++started === 2) both.resolve();
      await both.promise;
      finished++;
      if (failure === "rejected" && pg) throw new Error("do not record this error");
      const failed = failure === (pg ? "pg" : "pglite");
      return { exitCode: failed ? 7 : 0,
        ...(failure === "missing" && pg ? {} : { postgresSkipped: pg ? Number(failure === "skipped") : 143 }),
        unit: { failureCount: Number(failed), failures: failed ? [{ file: "tests/email.test.ts", title: pg ? "pg failure" : "pglite failure", status: "failed" }] : [] } };
    });
    const report = readReport(root), groups = report.steps[0].groups;
    assert.equal(finished, 2);
    assert.equal(code, ["pg", "pglite"].includes(failure) ? 7 : failure === "none" ? 0 : 1);
    assert.equal(advanced, failure === "none");
    assert.equal(report.browserExecution, "none");
    assert.equal(report.steps[0].browserServer, undefined);
    assert.equal(report.postgresSkippedInPglite, 143);
    assert.equal(report.postgresSkipped, Number(failure === "skipped"));
    assert.equal(new Set(groups.map(g => g.log)).size, 2);
    assert.ok(groups.every(g => Number.isInteger(g.exitCode) && g.durationMs >= 0));
    assert.equal(groups[0].unit.failures[0]?.title, failure === "pglite" ? "pglite failure" : undefined);
    if (failure !== "rejected") assert.equal(groups[1].unit.failures[0]?.title, failure === "pg" ? "pg failure" : undefined);
    assert.deepEqual(report.unrun, failure === "none" ? [] : ["after units"]);
    assert.ok(!JSON.stringify(report).includes("do not record this error"));
  });
}

test("unit backends overlap only after host admission, independently of browser grouping", t => {
  const root = fixture(t);
  for (const mode of [undefined, "serial", "invalid"]) {
    const units = planChecks(["release"], root, { ...pgEnv, TOMOLA_VALIDATE_MODE: mode }).steps.filter(s => s.name.startsWith("unit ("));
    assert.deepEqual(units.map(s => s.name), ["unit (PGlite)", "unit (PostgreSQL)"]);
    assert.ok(units.every(s => !s.parallel));
  }
  for (const serial of ["0", "1"]) {
    const plan = planChecks(["release"], root, { ...pgEnv, E2E_SERIAL: serial });
    const units = plan.steps.find(s => s.name === "unit (PGlite and PostgreSQL)");
    assert.equal(units.parallel.length, 2);
    assert.equal(Boolean(plan.steps.find(s => s.parallel?.some(child => child.group))), serial !== "1");
  }
});
