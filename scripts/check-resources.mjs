import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

export function hostResources() {
  // /proc reports host-wide load, so compare it with the host's logical CPU count.
  const cpuCount = os.cpus().length || null;
  let loadAverage = process.platform === "win32" ? null : os.loadavg();
  let availableMemoryKiB = null;
  if (process.platform === "linux") {
    try {
      const values = fs.readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/).slice(0, 3).map(Number);
      if (values.length === 3 && values.every(Number.isFinite)) loadAverage = values;
    } catch { /* Keep the OS load average if procfs is unavailable. */ }
    try {
      const match = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
      if (match) availableMemoryKiB = Number(match[1]);
    } catch { /* Available memory is optional evidence. */ }
  }
  return { loadAverage, cpuCount, availableMemoryKiB };
}

export function highLoadFailure({ start, end }) {
  const samples = [start, end].filter(sample => sample?.cpuCount > 0 && Number.isFinite(sample.loadAverage?.[0]));
  return samples.length ? samples.some(sample => sample.loadAverage[0] >= sample.cpuCount) : null;
}

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
