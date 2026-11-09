import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

export function inValidationBudget(cgroup) {
  return cgroup.split("\n").some(line => line.startsWith("0::/") && line.slice(3).split("/").includes("agent-workers.slice"));
}

export function findValidationRunner(environment) {
  const explicit = environment.TOMOLA_VALIDATION_RUNNER;
  if (explicit === "0") return null;
  const candidates = explicit ? [explicit] : (environment.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, "run-validation"));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    } catch { /* Optional host launcher is not installed here. */ }
  }
  if (explicit) throw new Error("The configured validation launcher is unavailable");
  return null;
}

export function validationCommand(command, environment, platform, cgroup) {
  if (platform !== "linux" || inValidationBudget(cgroup)) return null;
  const runner = findValidationRunner(environment);
  return runner ? [runner, "--label", "tomola-check", "--", ...command] : null;
}

export async function launchInValidationBudget(command, environment = process.env) {
  let cgroup = "";
  if (process.platform === "linux") {
    try { cgroup = fs.readFileSync("/proc/self/cgroup", "utf8"); } catch { /* The host launcher verifies the budget itself. */ }
  }
  const launch = validationCommand(command, environment, process.platform, cgroup);
  if (!launch) return null;
  return await new Promise((resolve, reject) => {
    const child = spawn(launch[0], launch.slice(1), { env: environment, stdio: "inherit" });
    const interrupt = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
    const onInterrupt = () => interrupt("SIGINT"), onTerminate = () => interrupt("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    const release = () => { process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate); };
    child.once("error", error => { release(); reject(error); });
    child.once("close", (code, signal) => { release(); resolve(code ?? 128 + (os.constants.signals[signal] ?? 1)); });
  });
}
