import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { browserServerEnvironment } from "../scripts/browser-resources.mjs";
import { inValidationBudget, validationCommand } from "../scripts/check-resources.mjs";

test("browser servers share the native CPU budget without changing test semantics or explicit overrides", () => {
  const input = { NODE_OPTIONS: "--import=fixture.mjs", E2E_PORT: "5400" };
  assert.deepEqual(browserServerEnvironment(input, "linux"), { ...input, ROLLDOWN_WORKER_THREADS: "4", RAYON_NUM_THREADS: "4", MALLOC_ARENA_MAX: "2" });
  assert.deepEqual(input, { NODE_OPTIONS: "--import=fixture.mjs", E2E_PORT: "5400" });
  const explicit = { ROLLDOWN_WORKER_THREADS: "8", RAYON_NUM_THREADS: "6", MALLOC_ARENA_MAX: "4" };
  assert.deepEqual(browserServerEnvironment(explicit, "linux"), explicit);
  assert.equal(browserServerEnvironment({}, "darwin").MALLOC_ARENA_MAX, undefined);
});

test("the host launcher is optional and nested job memory contracts are retained", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "validation-runner-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "run-validation");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const environment = { PATH: directory };
  const command = ["node", "scripts/check.mjs", "integration", "a b"];
  assert.deepEqual(validationCommand(command, environment, "linux", "0::/app.slice/agent.scope"), [executable, "--label", "tomola-check", "--", ...command]);
  assert.equal(validationCommand(command, environment, "linux", "0::/agent.slice/agent-workers.slice/agent-workers-guarded.slice/job.scope"), null);
  assert.equal(validationCommand(command, environment, "darwin", ""), null);
  assert.equal(validationCommand(command, { PATH: "" }, "linux", ""), null);
  assert.equal(validationCommand(command, { ...environment, TOMOLA_VALIDATION_RUNNER: "0" }, "linux", ""), null);
  assert.throws(() => validationCommand(command, { TOMOLA_VALIDATION_RUNNER: path.join(directory, "missing") }, "linux", ""));
  assert.equal(inValidationBudget("0::/app.slice/not-agent-workers.slice"), false);
});
