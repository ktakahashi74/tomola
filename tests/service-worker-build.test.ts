import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { serviceWorkerBuild, versionServiceWorker } from "../scripts/service-worker-build";
it("embeds each build identity in the worker without changing its allowlist", () => {
  const source = fs.readFileSync("public/sw.js", "utf8");
  const first = versionServiceWorker(source, "build-one");
  const second = versionServiceWorker(source, "build-two");
  expect(first).toContain('tomola-shell-build-one');
  expect(first).not.toContain('__TOMOLA_BUILD_ID__');
  expect(second).not.toBe(first);
  expect(first).toContain('credentials: "omit"');
  expect(() => versionServiceWorker(source, 'bad"value')).toThrow();
});

it("fails a client build with no worker while allowing server output without one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-sw-test-"));
  try {
    const hook = serviceWorkerBuild().writeBundle as Function;
    expect(() => hook.call({ environment: { config: { build: { ssr: true } } } }, { dir })).not.toThrow();
    expect(() => hook.call({ environment: { config: { build: { ssr: false } } } }, { dir })).toThrow(/sw\.js/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
