import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { generateNotices, checkNotices } from "../scripts/third-party-notices";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("detects a new locked production dependency and changed bundled license text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-notices-")); roots.push(root);
  const write = (file: string, value: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); };
  write("THIRD_PARTY_NOTICES.md", "# Manual notices\n");
  function dependencies(names: string[]) {
    write("package.json", JSON.stringify({ dependencies: Object.fromEntries(names.map(n => [n, "1.0.0"])) }));
    write("pnpm-lock.yaml", JSON.stringify({ importers: { ".": { dependencies: Object.fromEntries(names.map(n => [n, { specifier: "1.0.0", version: "1.0.0" }])) } }, snapshots: Object.fromEntries(names.map(n => [n + "@1.0.0", {}])), packages: Object.fromEntries(names.map(n => [n + "@1.0.0", {}])) }));
    for (const name of names) { write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: "1.0.0", license: "MIT" })); write(`node_modules/${name}/LICENSE`, `MIT License: ${name}`); }
  }
  dependencies(["first"]); write("THIRD_PARTY_NOTICES.md", generateNotices(root));
  expect(() => checkNotices(root)).not.toThrow();
  dependencies(["first", "second"]);
  expect(() => checkNotices(root)).toThrow(/out of date/);
  write("THIRD_PARTY_NOTICES.md", generateNotices(root));
  write("node_modules/second/LICENSE", "Changed copyright notice");
  expect(() => checkNotices(root)).toThrow(/out of date/);
  write("THIRD_PARTY_NOTICES.md", generateNotices(root));
  write("app/app.css", '@import "build-css/styles.css";');
  write("node_modules/build-css/package.json", JSON.stringify({ name: "build-css", version: "1.0.0", license: "MIT" }));
  write("node_modules/build-css/LICENSE", "Build CSS copyright");
  const lock = JSON.parse(fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  lock.importers["."].devDependencies = { "build-css": { specifier: "1.0.0", version: "1.0.0" } };
  lock.snapshots["build-css@1.0.0"] = {}; lock.packages["build-css@1.0.0"] = {};
  write("pnpm-lock.yaml", JSON.stringify(lock));
  expect(() => checkNotices(root)).toThrow(/out of date/);
  expect(generateNotices(root)).toContain("Build CSS copyright");
});
