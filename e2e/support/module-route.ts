import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type Route } from "@playwright/test";

// Resolve the file actually requested by the browser, in either server mode.
// Refuse missing or ambiguous chunks rather than silently bypassing a fault.
export function modulePath(source: string, root = process.cwd(), server = process.env.E2E_SERVER): string {
  if (!/^app\/(components|routes)\/[\w./-]+\.(tsx?|jsx?)$/.test(source) || source.includes("..")) throw new Error("Expected a client source module");
  if (server !== "build") return `/${source}`;
  const assets = path.join(root, "build/client/assets");
  if (source.startsWith("app/routes/")) {
    const manifests = fs.readdirSync(assets).filter(file => /^manifest-.*\.js$/.test(file))
      .map(file => fs.readFileSync(path.join(assets, file), "utf8").trim())
      .filter(text => /^window\.__reactRouterManifest\s*=/.test(text));
    if (manifests.length !== 1) throw new Error("Expected one browser route manifest");
    const manifest = JSON.parse(manifests[0].replace(/^window\.__reactRouterManifest\s*=\s*/, "").replace(/;\s*$/, ""));
    const module = manifest.routes[source.replace(/^app\//, "").replace(/\.[^.]+$/, "")]?.module;
    if (typeof module !== "string" || !module.startsWith("/assets/")) throw new Error(`No built route for ${source}`);
    return module;
  }
  const stem = path.basename(source).replace(/\.[^.]+$/, "");
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates = fs.readdirSync(assets).filter(file => new RegExp(`^${escaped}-[\\w-]+\\.js$`).test(file));
  if (candidates.length !== 1) throw new Error(`Expected one built chunk for ${source}, found ${candidates.length}`);
  return `/assets/${candidates[0]}`;
}

export function moduleTarget(source: string, root = process.cwd(), server = process.env.E2E_SERVER): string | RegExp {
  if (source !== "@simplewebauthn/browser") return modulePath(source, root, server);
  if (server !== "build") return /simplewebauthn(?:_|%2F|\/)browser/;
  // This dependency's build chunk has a generic entry name. Resolve it by its
  // exported API, requiring one match rather than assuming a generated hash.
  const assets = path.join(root, "build/client/assets");
  const candidates = fs.readdirSync(assets).filter(file => {
    if (!file.endsWith(".js")) return false;
    const contents = fs.readFileSync(path.join(assets, file), "utf8");
    return /\bstartAuthentication\s*:/.test(contents) && /\bstartRegistration\s*:/.test(contents);
  });
  if (candidates.length !== 1) throw new Error(`Expected one built chunk for ${source}, found ${candidates.length}`);
  return `/assets/${candidates[0]}`;
}

export async function routeModule(page: Page, source: string, handler: (route: Route) => Promise<void>) {
  const target = moduleTarget(source);
  const matches = (url: URL) => typeof target === "string" ? url.pathname === target : target.test(url.pathname);
  let hits = 0;
  const intercept = async (route: Route) => { hits++; await handler(route); };
  await page.route(matches, intercept);
  return {
    assertHit: () => expect.poll(() => hits, { message: `Module fault did not intercept ${target}` }).toBeGreaterThan(0),
    dispose: () => page.unroute(matches, intercept),
  };
}
