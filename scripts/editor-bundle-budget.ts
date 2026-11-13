export const READING_PAGE_GZIP_LIMIT = 342 * 1024;
export const WRITING_PAGE_GZIP_LIMIT = 455 * 1024;
export const WRITING_ROUTE_IDS = ["routes/topic-new", "routes/topic-edit"] as const;

export function pageGzipLimit(routeId: string): number {
  return (WRITING_ROUTE_IDS as readonly string[]).includes(routeId) ? WRITING_PAGE_GZIP_LIMIT : READING_PAGE_GZIP_LIMIT;
}

// Follow only static imports: this root is itself loaded on demand. Shared
// files are deduplicated against the route's initial scripts by the calculator.
export function collectStaticScripts(root: string, read: (file: string) => string): Set<string> {
  const files = new Set<string>();
  function visit(file: string) {
    if (!/^\/assets\/[\w.-]+\.js$/.test(file)) throw new Error(`Unexpected editor script path: ${file}`);
    if (files.has(file)) return;
    files.add(file);
    const source = read(file);
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.\/[\w.-]+\.js)["']/g)) {
      visit("/assets/" + match[1].slice(2));
    }
  }
  visit(root);
  return files;
}

export const PAGE_GZIP_GROWTH_LIMIT = 5 * 1024;

export function budgetViolations(sizes: readonly { routeId: string; gzipBytes: number }[], baseline: Readonly<Record<string, number>>) {
  const violations: Array<{ routeId: string; kind: 'absolute' | 'growth' | 'missing-baseline'; bytes: number }> = [];
  for (const [route, bytes] of Object.entries(baseline)) if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Invalid baseline: ${route}`);
  for (const { routeId, gzipBytes } of sizes) {
    if (gzipBytes > pageGzipLimit(routeId)) violations.push({ routeId, kind: 'absolute', bytes: gzipBytes });
    if (!Object.hasOwn(baseline, routeId)) violations.push({ routeId, kind: 'missing-baseline', bytes: gzipBytes });
    else if (gzipBytes - baseline[routeId] >= PAGE_GZIP_GROWTH_LIMIT) violations.push({ routeId, kind: 'growth', bytes: gzipBytes - baseline[routeId] });
  }
  return violations;
}
