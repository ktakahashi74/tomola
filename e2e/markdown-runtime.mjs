import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Test process preload. It installs options, not a source-module executor:
// production uses the build's own classes and development uses Vite's classes.
const directory = process.env.E2E_SEED_DIR ?? (process.env.E2E_SERVER_CLOCK ? path.dirname(process.env.E2E_SERVER_CLOCK) : null);
if (directory) {
  const workerFile = path.join(directory, "markdown-worker.mjs");
  const control = { realCalibration: true, holdFile: path.join(directory, "markdown-hold"), startedDirectory: path.join(directory, "markdown-started") };
  fs.mkdirSync(control.startedDirectory, { recursive: true });
  fs.writeFileSync(workerFile, `globalThis.markdownFixtureControl=${JSON.stringify(control)};\nawait import(${JSON.stringify(pathToFileURL(path.resolve("tests/helpers/markdown-worker.mjs")).href)});\n`);
  globalThis.__tomolaMarkdownTestOptions = { workerFile };
}
