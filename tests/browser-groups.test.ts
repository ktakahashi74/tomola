import { decodeHeader } from "../e2e-prod/support/fake-smtp";
import { expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";
import { browserFiles, browserFilePatterns, browserPorts, partitionBrowserFiles, browserGroupCount, privateBrowserGroups } from "../scripts/browser-groups";
import { publicOnly, bothModes, publicOnlyTests, readingModePattern } from "../e2e/reading-modes";
import { modulePath, moduleTarget } from "../e2e/support/module-route";

it("keeps every reading-mode row matched to collected browser tests, including generated titles", () => {
  const environment = { ...process.env };
  for (const key of ["E2E_BROWSER_GROUP", "PLAYWRIGHT_JSON_OUTPUT_FILE", "PLAYWRIGHT_JSON_OUTPUT_NAME", "PLAYWRIGHT_JSON_OUTPUT_DIR"]) delete environment[key];
  const titles = (suites: JSONReportSuite[], parents: string[] = []): string[] => suites.flatMap(suite => {
    const prefix = [...parents, suite.title];
    return [...suite.specs.map(spec => [...prefix, spec.title].join(" ")), ...titles(suite.suites ?? [], prefix)];
  });
  // The private inverse and public inventory together cover every collected test.
  // Listing evaluates declarations and loops without running setup or test bodies.
  const allTitles = ["playwright.config.ts", "playwright.public.config.ts"].flatMap(config => {
    const listed = spawnSync(process.execPath, [path.resolve("node_modules/@playwright/test/cli.js"), "test", "-c", config, "--list", "--reporter=json"], {
      env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    });
    expect(listed.error, listed.stderr).toBeUndefined();
    expect(listed.status, listed.stderr).toBe(0);
    const report = JSON.parse(listed.stdout) as JSONReport;
    expect(report.errors).toEqual([]);
    expect(report.suites.length).toBeGreaterThan(0);
    return titles(report.suites);
  });
  for (const cases of [publicOnly, bothModes]) for (const row of cases) {
    expect(allTitles.filter(title => readingModePattern([row]).test(title)), `Unmatched reading-mode row: ${row.join(" / ")}`).not.toHaveLength(0);
  }
}, 65_000);

it("anchors reading-mode filenames at a delimiter in file lists and Playwright title paths", () => {
  const pattern = readingModePattern([["moderation", "operator signs up"]]);
  for (const prefix of ["", "chromium ", "chromium nested/", "chromium nested\\"]) {
    expect(pattern.test(`${prefix}moderation.spec.ts moderation operator signs up`)).toBe(true);
    for (const file of ["ai-moderation", "village-moderation", "othermoderation"]) expect(pattern.test(`${prefix}${file}.spec.ts operator signs up`)).toBe(false);
  }
  expect(readingModePattern([["moderation", ".*"]]).test("moderation.spec.ts ")).toBe(true);
  expect(pattern.test("moderation.spec.tsx operator signs up")).toBe(false);
});

it("partitions each private file exactly once and preserves complete files", () => {
  const groups = privateBrowserGroups().map(group => browserFiles(process.cwd(), group));
  const files = groups.flat();
  const all = fs.globSync("**/*.spec.ts", { cwd: path.join(process.cwd(), "e2e") }).filter(file => !publicOnlyTests.test(`${file} `)).sort();
  expect([...files].sort()).toEqual(all);
  expect(new Set(files).size).toBe(files.length);
  expect(browserFiles(process.cwd(), "a")).toEqual(groups[0]);
});
it("matches group files by their complete paths even when basenames and root suffixes overlap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-browser-[paths]-"));
  try {
    const names = ["same.spec.ts", "nested/same.spec.ts"];
    for (const file of names) { const target = path.join(root, "e2e", file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "test('fixture', () => {});"); }
    const matches: Record<string, RegExp[]> = {};
    for (const group of ["a", "b"]) {
      vi.stubEnv("E2E_BROWSER_GROUP", group); vi.stubEnv("E2E_GROUPS", "3"); vi.spyOn(process, "cwd").mockReturnValue(root); vi.resetModules();
      const { default: config } = await import("../playwright.config");
      matches[group] = config.testMatch as RegExp[];
      expect(matches[group].every(pattern => pattern instanceof RegExp)).toBe(true);
      vi.restoreAllMocks();
    }
    for (const file of names) {
      const pathname = path.join(root, "e2e", file);
      const owner = ["a", "b"].filter(group => matches[group].some(pattern => pattern.test(pathname)));
      expect(owner).toHaveLength(1);
      const other = names.find(name => name !== file)!;
      expect(matches[owner[0]].some(pattern => pattern.test(path.join(root, "e2e", other)))).toBe(false);
      expect(Object.values(matches).flat().some(pattern => pattern.test(path.join(root, "e2e", "extra", file)) || pattern.test(`/extra${pathname}`))).toBe(false);
    }
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(root, { recursive: true, force: true }); }
});
it("includes nested specs exactly once and follows the serial config's explicit discovery policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-browser-discovery-"));
  try {
    const files = ["first.spec.ts", "nested/second.spec.ts", "nested/deeper/third.spec.ts", "ignored.test.ts", "ignored.spec.js", "helper.ts"];
    for (const file of files) { const target = path.join(root, "e2e", file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "test('fixture', () => {});"); }
    expect([...browserFiles(root, "a", 3), ...browserFiles(root, "b", 3)].sort()).toEqual(["first.spec.ts", "nested/deeper/third.spec.ts", "nested/second.spec.ts"]);
    const patterns = ["a", "b"].flatMap(group => browserFilePatterns(root, group, 3));
    for (const file of files) expect(patterns.filter(pattern => pattern.test(path.join(root, "e2e", file)))).toHaveLength(file.endsWith(".spec.ts") ? 1 : 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it("balances a deterministic partition by workload rather than file order", () => {
  const weights = { "slow.spec.ts": 30, "second.spec.ts": 20, "third.spec.ts": 10, "small.spec.ts": 5 };
  const files = Object.keys(weights);
  const normal = partitionBrowserFiles(files, weights, 3);
  expect(partitionBrowserFiles([...files].reverse(), weights, 3)).toEqual(normal);
  expect(Math.abs(normal.totals.a - normal.totals.b)).toBeLessThanOrEqual(5);
});
it("allocates disjoint ports and rejects input that cannot fit all groups", () => {
  expect(browserPorts("5311", 3)).toEqual({ a: "5311", b: "15311", public: "25311" });
  for (const base of ["0", "1023", "65535", "5e3", "5311suffix", "5311.5"]) expect(() => browserPorts(base)).toThrow();
});

for (const count of [3, 4, 5, 6]) it(`covers every private file once with ${count} groups and reserves disjoint services`, () => {
  const groups = privateBrowserGroups(count);
  const files = groups.flatMap(group => browserFiles(process.cwd(), group, count));
  const all = fs.globSync("**/*.spec.ts", { cwd: path.join(process.cwd(), "e2e") }).filter(file => !publicOnlyTests.test(`${file} `)).sort();
  expect(files.sort()).toEqual(all);
  expect(new Set(files).size).toBe(files.length);
  const ports = Object.values(browserPorts(5446, count)).flatMap(port => [Number(port), Number(port) + 1, Number(port) + 2]);
  expect(new Set(ports).size).toBe(count * 3);
  expect(() => browserPorts(65534 - (count - 1) * 10_000, count)).toThrow();
  expect(Object.values(browserPorts(65533 - (count - 1) * 10_000, count)).at(-1)).toBe("65533");
});
it("rejects malformed group counts and unknown private groups", () => {
  for (const value of ["", "2", "7", "3.5", "3extra"]) expect(() => browserGroupCount(value)).toThrow();
  expect(() => browserFiles(process.cwd(), "c", 3)).toThrow();
});

it("resolves development URLs and built route/chunk URLs, refusing missing and ambiguous injection targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-module-path-"));
  try {
    const assets = path.join(root, "build/client/assets");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "manifest-current.js"), 'window.__reactRouterManifest = {"routes":{"routes/settings":{"module":"/assets/settings-real.js"}}};');
    fs.writeFileSync(path.join(assets, "editor.client-current.js"), "");
    expect(modulePath("app/components/editor.client.tsx", root, "development")).toBe("/app/components/editor.client.tsx");
    expect(modulePath("app/components/editor.client.tsx", root, "build")).toBe("/assets/editor.client-current.js");
    expect(modulePath("app/routes/settings.tsx", root, "build")).toBe("/assets/settings-real.js");
    expect(() => modulePath("app/components/missing.tsx", root, "build")).toThrow();
    fs.writeFileSync(path.join(assets, "editor.client-other.js"), "");
    expect(() => modulePath("app/components/editor.client.tsx", root, "build")).toThrow();
    expect(() => modulePath("app/../outside.tsx", root, "build")).toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("decodes folded SMTP subjects without adding spaces between encoded words", () => {
  const first = Buffer.from("tomolaのログ").toString("base64");
  const last = Buffer.from("イン").toString("base64");
  expect(decodeHeader(`=?UTF-8?B?${first}?=\r\n =?UTF-8?B?${last}?=`)).toBe("tomolaのログイン");
  expect(decodeHeader("Hello =?UTF-8?Q?wide_world?=")).toBe("Hello wide world");
});

it("resolves a bundled passkey dependency uniquely while retaining its development matcher", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-dependency-target-"));
  try {
    const assets = path.join(root, "build/client/assets");
    fs.mkdirSync(assets, { recursive: true });
    const development = moduleTarget("@simplewebauthn/browser", root, "development") as RegExp;
    expect(development.test("/node_modules/.vite-e2e/deps/@simplewebauthn_browser.js")).toBe(true);
    expect(development.test("/assets/unrelated.js")).toBe(false);
    expect(() => moduleTarget("@simplewebauthn/browser", root, "build")).toThrow();
    const exports = "const api={startAuthentication:()=>{},startRegistration:()=>{}};";
    fs.writeFileSync(path.join(assets, "esm-current.js"), exports);
    expect(moduleTarget("@simplewebauthn/browser", root, "build")).toBe("/assets/esm-current.js");
    fs.writeFileSync(path.join(assets, "esm-other.js"), exports);
    expect(() => moduleTarget("@simplewebauthn/browser", root, "build")).toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
