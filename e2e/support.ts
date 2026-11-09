import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// Shared browser-test setup and cleanup tools for e2e/ and e2e-prod/, used by their global-setup.ts files.

// Detect an existing listener on the port, such as a dev server left by an earlier run; fail with a clear error.
// Vite strictPort prevents silently choosing another port, but setup's readiness wait could still connect to a leftover server on the same port with an old DB or code,
// running tests against the wrong server. Check both 127.0.0.1 and ::1 because localhost can resolve to either.
export async function assertPortFree(port: number): Promise<void> {
  for (const host of ["127.0.0.1", "::1"]) {
    const inUse = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(2_000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (inUse) throw new Error(`port ${port} is already in use on ${host}: a dev server left over from an earlier run? Stop it, or use another port (E2E_PORT).`);
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// Read the process command line from /proc on Linux or ps elsewhere; return null if unavailable.
export function commandLineOf(pid: number): string | null {
  try {
    if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+/g, " ").trim() || null;
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

// Check whether this process leads its process group; only a group leader permits stopping the whole group.
export function isProcessGroupLeader(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      // /proc/<pid>/stat has the form "pid (comm) state ppid pgrp ...". comm may contain spaces and parentheses, so read after the final closing parenthesis.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return Number(rest[2]) === pid;
    }
    return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) === pid;
  } catch {
    return false;
  }
}

// Verify the pid file refers to an earlier E2E server: its command line contains the working-directory path, server.ts or react-router.
// PIDs can be reused by unrelated processes after a run ends; killing without this check could stop an unrelated process.
export function isLeftoverServer(pid: number, dir: string): boolean {
  const command = commandLineOf(pid);
  return command !== null && (command.includes(dir) || /\bserver\.ts\b/.test(command) || /react-router/.test(command));
}

// Remove leftover working directories under dataRoot whose names start with prefix. Keep a directory if its owner.pid (the Playwright setup process)
// is alive and another run is using it, or if .keep records E2E_KEEP preservation for debugging.
// Leftovers occur when a server fails to stop, for example after forced termination or power loss. Also stop server.pid if it can be verified as the leftover E2E server.
export function removeStaleDirs(dataRoot: string, prefix: string): string[] {
  const removed: string[] = [];
  if (!fs.existsSync(dataRoot)) return removed;
  for (const name of fs.readdirSync(dataRoot)) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(dataRoot, name);
    if (!fs.statSync(dir).isDirectory() || fs.existsSync(path.join(dir, ".keep"))) continue;
    const pidOf = (file: string) => {
      try {
        const pid = Number.parseInt(fs.readFileSync(path.join(dir, file), "utf8"), 10);
        return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    };
    const owner = pidOf("owner.pid");
    if (owner !== null && owner !== process.pid && alive(owner)) continue;
    // Stop a leftover process only if the PID is alive and belongs to an E2E server. Otherwise leave the unrelated process alone and remove only the directory.
    // Stop an entire process group (used for the dev server) only if the process is its leader.
    const server = pidOf("server.pid");
    if (server !== null && alive(server) && isLeftoverServer(server, dir)) {
      try {
        process.kill(isProcessGroupLeader(server) ? -server : server, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

// On Ctrl-C (SIGINT) or kill (SIGTERM) during setup or tests, finish cleanup (stop server, remove directory), then terminate with the same signal.
// Playwright sometimes skips the globalSetup cleanup function on Ctrl-C. The returned function unregisters these handlers during normal cleanup.
export function cleanupOnSignals(cleanup: () => Promise<void>): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      for (const [name, h] of handlers) process.off(name, h);
      void cleanup().finally(() => process.kill(process.pid, signal));
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [name, h] of handlers) process.off(name, h);
    handlers.clear();
  };
}
