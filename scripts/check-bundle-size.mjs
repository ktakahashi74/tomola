// Keep each page's JavaScript within the agreed loading budget. Revisit this
// limit as network availability and the devices used by readers change.

import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { calculateRouteSizes } from "./bundle-size.ts";
import { collectStaticScripts, pageGzipLimit, READING_PAGE_GZIP_LIMIT, WRITING_PAGE_GZIP_LIMIT, WRITING_ROUTE_IDS, budgetViolations, PAGE_GZIP_GROWTH_LIMIT } from "./editor-bundle-budget.ts";

try {
  const client = path.resolve("build/client");
  const assets = path.join(client, "assets");
  const manifests = fs.readdirSync(assets).filter((name) => /^manifest-.*\.js$/.test(name))
    .map((name) => fs.readFileSync(path.join(assets, name), "utf8").trim())
    // React Router also emits an empty manifest placeholder during the build.
    .filter(Boolean);
  if (manifests.length !== 1) throw new Error("Expected one nonempty React Router manifest; run pnpm build first");
  const match = /^window\.__reactRouterManifest\s*=\s*(\{[\s\S]*\});?$/.exec(manifests[0]);
  if (!match) throw new Error("Unrecognized React Router manifest");
  const manifest = JSON.parse(match[1]);
  const editorRoots = fs.readdirSync(assets).filter(name => /^rich-text-editor\.client-.*\.js$/.test(name));
  if (editorRoots.length !== 1) throw new Error("Expected one lazy rich text editor script");
  const editorScripts = collectStaticScripts("/assets/" + editorRoots[0], file => fs.readFileSync(path.join(client, file), "utf8"));
  const files = new Set([manifest.entry.module, ...(manifest.entry.imports ?? [])]);
  for (const route of Object.values(manifest.routes)) {
    files.add(route.module);
    for (const file of route.imports ?? []) files.add(file);
  }
  for (const file of editorScripts) files.add(file);
  const gzipSizes = Object.fromEntries([...files].map((file) => {
    if (!file.startsWith("/assets/") || file.includes("\\") || path.posix.normalize(file) !== file) {
      throw new Error(`Unexpected script path: ${file}`);
    }
    return [file, gzipSync(fs.readFileSync(path.join(client, file))).length];
  }));
  const initialSizes = calculateRouteSizes(manifest, gzipSizes);
  const sizes = calculateRouteSizes(manifest, gzipSizes, Object.fromEntries(WRITING_ROUTE_IDS.map(id => [id, [...editorScripts]])));
  if (!sizes.length) throw new Error("No page routes in the manifest");
  const baselineFile = new URL('./check-baselines/bundle.json', import.meta.url);
  if (process.argv.includes('--write-baseline')) {
    if (sizes.some(row => row.gzipBytes > pageGzipLimit(row.routeId))) throw new Error('Cannot baseline a page over its absolute limit');
    fs.mkdirSync(new URL('.', baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify(Object.fromEntries(sizes.map(row => [row.routeId, row.gzipBytes]).sort()), null, 2) + '\n');
    console.log('Page baseline written; review its diff before committing.');
  }
  const violations = budgetViolations(sizes, JSON.parse(fs.readFileSync(baselineFile, 'utf8')));
  for (const row of violations) console.error(`${row.routeId}: ${row.kind} (${row.bytes} bytes; growth threshold ${PAGE_GZIP_GROWTH_LIMIT})`);
  const exceeded = sizes.filter(({ routeId, gzipBytes }) => gzipBytes > pageGzipLimit(routeId));
  for (const routeId of WRITING_ROUTE_IDS) {
    const initial = initialSizes.find(row => row.routeId === routeId);
    const rich = sizes.find(row => row.routeId === routeId);
    if (!initial || !rich) throw new Error(`Missing writing route: ${routeId}`);
    console.log(`${routeId}: Markdown ${(initial.gzipBytes / 1024).toFixed(2)} KiB; rich text ${(rich.gzipBytes / 1024).toFixed(2)} KiB gzip`);
  }
  const selected = exceeded.length ? exceeded : sizes.slice(0, 3);
  for (const { routeId, gzipBytes } of selected) {
    console.log(`${routeId}: ${(gzipBytes / 1024).toFixed(2)} KiB gzip (${gzipBytes} bytes)`);
  }
  if (violations.length) {
    console.error("Page JavaScript exceeds its route budget");
    process.exitCode = 1;
  } else {
    console.log(`${sizes.length} page routes within budget (reading ${READING_PAGE_GZIP_LIMIT / 1024}, writing ${WRITING_PAGE_GZIP_LIMIT / 1024} KiB gzip)`);
  }
} catch (error) {
  console.error(`[bundle-size] ${error.message}`);
  process.exitCode = 1;
}
