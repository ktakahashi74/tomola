import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const images = ["/favicon.ico", "/icons/icon.svg", "/icons/apple-touch-icon.png", "/icons/logomark.svg"] as const;

// Replace literals while compiling both server and client modules. No version
// table or hashing code enters page scripts. A shared content fingerprint and
// short asset names keep them small; editing any image refreshes the whole set.
export function publicImageVersions(): Plugin {
  let publicDir: string;
  let appDir: string;
  let building: boolean;
  const versions = () => {
    const sources = images.map(url => ({ url, source: readFileSync(path.join(publicDir, url)) }));
    const digest = createHash("sha256");
    for (const { url, source } of sources) digest.update(url).update("\0").update(String(source.length)).update("\0").update(source);
    const hash = digest.digest("hex").slice(0, 8);
    return sources.map(image => ({ ...image,
      // Keep the browser's implicit favicon location; explicit links get a new cache key.
      href: image.url === "/favicon.ico" ? `/favicon.ico?v=${hash}`
        : `/${image.url === "/icons/icon.svg" ? "t" : image.url === "/icons/logomark.svg" ? "l" : ""}${hash}${path.extname(image.url)}`,
    }));
  };
  return {
    name: "public-image-versions",
    enforce: "pre",
    configResolved(config) {
      publicDir = config.publicDir;
      appDir = path.join(config.root, "app") + path.sep;
      building = config.command === "build";
    },
    buildStart() {
      if (!building || this.environment.config.build.ssr) return;
      for (const { url, href, source } of versions()) {
        if (url !== "/favicon.ico") this.emitFile({ type: "asset", fileName: href.slice(1), source });
      }
    },
    configureServer(server) {
      // Serve the same content-addressed names in development without writing copies.
      server.middlewares.use((request, _response, next) => {
        const [pathname, query] = (request.url ?? "").split("?", 2);
        if (/^\/[tl]?[a-f0-9]{8}\.(svg|png)$/.test(pathname)) {
          const original = versions().find(image => image.href === pathname);
          if (original) request.url = original.url + (query ? `?${query}` : "");
        }
        next();
      });
    },
    transform(source, id) {
      const file = id.split("?", 1)[0];
      if (!file.startsWith(appDir) || !file.endsWith(".tsx") || !images.some(url => source.includes(url))) return;
      const current = versions();
      for (const image of current) this.addWatchFile(path.join(publicDir, image.url));
      const code = source.replace(/(['"])(\/(?:favicon\.ico|icons\/(?:icon\.svg|apple-touch-icon\.png|logomark\.svg)))\1/g, (_match, quote: string, url: string) => {
        return quote + current.find(image => image.url === url)!.href + quote;
      });
      return code === source ? null : { code, map: null };
    },
  };
}
