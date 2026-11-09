import fs from "node:fs";
import path from "node:path";
import { publicOnlyTests } from "../e2e/reading-modes.ts";

// Relative weights are measured per file. Unlisted files use their test declarations.
export const BROWSER_FILE_SECONDS: Readonly<Record<string, number>> = JSON.parse(
  fs.readFileSync(new URL('./browser-weights.json', import.meta.url), 'utf8'),
);

export const DEFAULT_BROWSER_GROUPS = 4;

export function browserGroupCount(value: string | number = DEFAULT_BROWSER_GROUPS): number {
  if (!/^[3-6]$/.test(String(value))) throw new Error("E2E_GROUPS must be between 3 and 6 (including public reading)");
  return Number(value);
}

export function privateBrowserGroups(count = DEFAULT_BROWSER_GROUPS): string[] {
  return Array.from({ length: browserGroupCount(count) - 1 }, (_, index) => String.fromCharCode(97 + index));
}

export function partitionBrowserFiles(files: readonly string[], weights: Readonly<Record<string, number>> = BROWSER_FILE_SECONDS, count = DEFAULT_BROWSER_GROUPS) {
  const names = privateBrowserGroups(count);
  const groups: Record<string, string[]> = Object.fromEntries(names.map(name => [name, []]));
  const totals: Record<string, number> = Object.fromEntries(names.map(name => [name, 0]));
  const ordered = files.map(file => ({ file, weight: weights[file] ?? 1 }))
    .sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));
  for (const { file, weight } of ordered) {
    const group = names.reduce((best, name) => totals[name] < totals[best] ? name : best);
    groups[group].push(file); totals[group] += weight;
  }
  return { groups: Object.fromEntries(names.map(name => [name, groups[name].sort()])), totals };
}

export function browserFiles(root: string, group: string, count = DEFAULT_BROWSER_GROUPS) {
  if (!privateBrowserGroups(count).includes(group)) throw new Error("Unknown private browser group");
  const directory = path.join(root, "e2e");
  // Match the explicit Playwright policy, including nested test directories.
  const collect = (relative = ""): string[] => fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const file = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? collect(file) : entry.isFile() && file.endsWith(".spec.ts") ? [file] : [];
  });
  const files = collect().filter(file => !publicOnlyTests.test(`${file} `));
  const weights = Object.fromEntries(files.map(file => [file, BROWSER_FILE_SECONDS[file] ?? Math.max(1, (fs.readFileSync(path.join(directory, file), "utf8").match(/\btest\(/g) ?? []).length) * 4]));
  return partitionBrowserFiles(files, weights, count).groups[group];
}

export function browserPorts(base: string | number = "5199", count = DEFAULT_BROWSER_GROUPS) {
  if (!/^\d+$/.test(String(base))) throw new Error("E2E_PORT must be a port number");
  const first = Number(base);
  const groups = [...privateBrowserGroups(count), "public"];
  if (!Number.isSafeInteger(first) || first < 1024 || first + (groups.length - 1) * 10_000 + 2 > 65535) throw new Error("E2E_PORT leaves no room for the browser groups and local services");
  return Object.fromEntries(groups.map((group, index) => [group, String(first + index * 10_000)]));
}

export function browserFilePatterns(root: string, group: string, count = DEFAULT_BROWSER_GROUPS) {
  return browserFiles(root, group, count).map(file => new RegExp(`^${path.resolve(root, "e2e", file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}
