import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Package-manager shims can embed absolute dependency paths, including NODE_PATH.
// A source copy must launch its own CLI packages rather than the parent's copies.
export function relocateDependencyShims(root, directory) {
  const sourcePrefix = path.resolve(root) + path.sep, destinationPrefix = path.resolve(directory) + path.sep;
  const bins = path.join(directory, "node_modules", ".bin");
  if (!fs.existsSync(bins)) return;
  for (const name of fs.readdirSync(bins)) {
    const file = path.join(bins, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) continue;
    const contents = fs.readFileSync(file, "utf8");
    if (contents.includes(sourcePrefix)) fs.writeFileSync(file, contents.replaceAll(sourcePrefix, destinationPrefix));
  }
}

// Each server owns its generated routes, messages and dependency cache as well as its data.
export function createBrowserWorkspace(root, group, environment = {}) {
  const parent = path.join(root, ".data", "checks", "browser-workspaces");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, `${group}-`));
  try {
    fs.writeFileSync(path.join(directory, "owner.pid"), String(process.pid));
    const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (listed.status !== 0 || listed.error) throw new Error("Could not enumerate browser source files");
    for (const relative of new Set(listed.stdout.split("\0").filter(Boolean))) {
      if (path.isAbsolute(relative) || relative.includes("\\") || path.posix.normalize(relative) !== relative || relative.startsWith("../")) throw new Error("Invalid browser source path");
      if (relative.startsWith(".env") && relative !== ".env.example") continue;
      const source = path.join(root, relative), destination = path.join(directory, relative);
      if (!fs.existsSync(source)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
      else if (stat.isFile()) fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
    }
    for (const relative of ["app/paraglide", "app/lib/i18n/review-counts.generated.json", ".react-router/types"]) {
      const source = path.join(root, relative);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(directory, relative), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    }
    fs.cpSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    relocateDependencyShims(root, directory);
    if (environment.E2E_SERVER === "build") {
      fs.cpSync(path.join(root, "build"), path.join(directory, "build"), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    }
    return directory;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function collectBrowserArtifacts(root, directory, group, environment = {}) {
  const destination = path.join(root, ".data", "checks", "browser-artifacts", `${group}-${path.basename(directory)}`);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "owner.pid"), String(process.pid));
  if (environment.E2E_KEEP) fs.writeFileSync(path.join(destination, ".keep"), "");
  const measurements = path.join(directory, ".data");
  if (fs.existsSync(measurements)) fs.cpSync(measurements, path.join(destination, "measurements"), { recursive: true });
  for (const [source, relative] of [[environment.E2E_BROWSER_OUTPUT, "test-results"], [environment.E2E_DATA_ROOT, "data"]]) {
    if (!source || !fs.existsSync(source)) continue;
    try {
      if (relative !== "data" || environment.E2E_KEEP) fs.cpSync(source, path.join(destination, relative), { recursive: true });
    } finally { fs.rmSync(source, { recursive: true, force: true }); }
  }
  return destination;
}

export function removeBrowserWorkspace(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
function hasLiveOwner(directory) {
  try {
    const text = fs.readFileSync(path.join(directory, "owner.pid"), "utf8").trim();
    const pid = Number(text);
    if (/^\d+$/.test(text) && Number.isSafeInteger(pid) && pid > 0 && alive(pid)) return true;
  } catch { /* Older workspaces have no owner marker. */ }
  // A killed runner can leave its server alive. Protect old unmarked copies too.
  if (process.platform !== "linux") return !fs.existsSync(path.join(directory, "owner.pid"));
  const realDirectory = fs.realpathSync(directory);
  for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === realDirectory || cwd.startsWith(realDirectory + path.sep)) return true;
    } catch { /* Exited or inaccessible. */ }
  }
  return false;
}

// Reclaim interrupted copies; retain a week of finished logs and evidence.
// Never follow symlinks or remove a kept directory or a live run's output.
export function cleanupBrowserRuns(root, { now = Date.now(), retentionMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const removed = [];
  for (const kind of ["browser-workspaces", "browser-artifacts", "browser-logs", "unit-logs"]) {
    const parent = path.join(root, ".data", "checks", kind);
    if (!fs.existsSync(parent)) continue;
    for (const name of fs.readdirSync(parent)) {
      try {
        const directory = path.join(parent, name), stat = fs.lstatSync(directory);
        if (stat.isSymbolicLink() || fs.existsSync(path.join(directory, ".keep"))) continue;
        if (kind === "browser-workspaces" && (!stat.isDirectory() || !/^([a-e]|public)-/.test(name))) continue;
        // Another runner may be between mkdir and writing its owner marker.
        if (kind === "browser-workspaces" && now - stat.mtimeMs < 60_000) continue;
        if (stat.isDirectory() && hasLiveOwner(directory)) continue;
        if (kind !== "browser-workspaces" && now - stat.mtimeMs < retentionMs) continue;
        if (!stat.isDirectory() && (kind !== "browser-logs" || !/^\d+-([a-e]|public)\.log$/.test(name))) continue;
        fs.rmSync(directory, { recursive: true, force: true }); removed.push(path.relative(root, directory));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return removed;
}
