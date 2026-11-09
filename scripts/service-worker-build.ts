import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export function versionServiceWorker(source: string, buildId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(buildId)) throw new Error("Invalid service worker build identity");
  if (!source.includes("__TOMOLA_BUILD_ID__")) throw new Error("Missing service worker build placeholder");
  return source.replaceAll("__TOMOLA_BUILD_ID__", buildId);
}

export function serviceWorkerBuild(): Plugin {
  const buildId = randomUUID();
  return { name: "service-worker-build", apply: "build", writeBundle(options) {
    if (this.environment.config.build.ssr) return;
    if (!options.dir) throw new Error("Client output directory is missing; cannot version sw.js");
    const file = path.join(options.dir, "sw.js");
    if (!fs.existsSync(file)) throw new Error(`Missing client service worker: ${file}`);
    fs.writeFileSync(file, versionServiceWorker(fs.readFileSync(file, "utf8"), buildId));
  } };
}
