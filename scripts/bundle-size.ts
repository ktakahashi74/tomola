export type BundleManifest = {
  entry: { module: string; imports?: string[] };
  routes: Record<string, {
    id: string;
    parentId?: string;
    module: string;
    imports?: string[];
    hasDefaultExport?: boolean;
  }>;
};

// Each page loads the entry and its ancestor routes. Count shared scripts once.
export function calculateRouteSizes(manifest: BundleManifest, gzipSizes: Readonly<Record<string, number>>, optionalImports: Readonly<Record<string, readonly string[]>> = {}) {
  return Object.values(manifest.routes).filter((route) => route.hasDefaultExport).map((route) => {
    const files = new Set([manifest.entry.module, ...(manifest.entry.imports ?? [])]);
    for (const file of optionalImports[route.id] ?? []) files.add(file);
    const ancestors = new Set<string>();
    let ancestor: typeof route | undefined = route;
    while (ancestor) {
      if (ancestors.has(ancestor.id)) throw new Error(`Cyclic route ancestry: ${route.id}`);
      ancestors.add(ancestor.id);
      files.add(ancestor.module);
      for (const file of ancestor.imports ?? []) files.add(file);
      const parentId: string | undefined = ancestor.parentId;
      ancestor = parentId === undefined ? undefined : manifest.routes[parentId];
      if (parentId !== undefined && !ancestor) throw new Error(`Missing parent route: ${parentId}`);
    }
    const gzipBytes = [...files].reduce((sum, file) => {
      const size = gzipSizes[file];
      if (!Object.hasOwn(gzipSizes, file) || !Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Missing or invalid gzip size: ${file}`);
      }
      return sum + size;
    }, 0);
    return { routeId: route.id, gzipBytes };
  }).sort((a, b) => b.gzipBytes - a.gzipBytes || a.routeId.localeCompare(b.routeId));
}
