import { versionServiceWorker } from "../scripts/service-worker-build";
import { publicImageVersions } from "../scripts/public-image-versions";
import { build as viteBuild } from "vite";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import express from "express";
import sharp from "sharp";
import { generateIcons } from "../scripts/generate-icons";
import { PwaRegistration } from "~/components/pwa-registration";
import { afterAll, describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy, withSecurityHeaders } from "~/lib/http/security-headers.server";
import { REVALIDATED_STATIC_PATHS, setStaticHeaders } from "../server/static-headers";
import { loader as offlineLoader } from "~/routes/offline";
import { offlineSections, renderOfflinePage, type OfflineText } from "~/lib/offline-page";
import { LANGS } from "~/lib/languages";

// Use actual messages/<language>.json wording for /offline; ordinary tests replace messages with empty strings.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

// Home-screen installation (PWA): manifest and icons, /offline, the service worker public/sw.js, CSP, and static-file headers.
// Production-build browser tests in e2e-prod/production.spec.ts verify actual responses: MIME types, headers, service-worker registration and cache contents, and offline guidance.
const { effects } = vi.hoisted(() => ({ effects: [] as Array<() => void> }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void) => { effects.push(effect); },
}));
const publicDir = path.join(process.cwd(), "public");
const readPublic = (file: string) => fs.readFileSync(path.join(publicDir, file));

it("builds content-versioned image references and changes each URL after a one-byte edit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-image-versions-"));
  const files = ["/favicon.ico", "/icons/icon.svg", "/icons/apple-touch-icon.png", "/icons/logomark.svg"];
  try {
    fs.mkdirSync(path.join(directory, "public/icons"), { recursive: true });
    fs.mkdirSync(path.join(directory, "app"));
    for (const file of files) fs.writeFileSync(path.join(directory, "public", file), readPublic(file));
    fs.writeFileSync(path.join(directory, "app/entry.tsx"), `export default ${JSON.stringify([...files, "/icons/share-default.png", "/manifest.webmanifest"])};`);
    const build = async () => {
      const result = await viteBuild({ configFile: false, root: directory, logLevel: "silent", plugins: [publicImageVersions()],
        build: { write: false, minify: false, lib: { entry: path.join(directory, "app/entry.tsx"), formats: ["es"] } } });
      const bundle = Array.isArray(result) ? result[0] : result;
      if (!bundle || !("output" in bundle)) throw new Error("Expected a build output");
      const script = bundle.output.find(file => file.type === "chunk");
      if (!script || script.type !== "chunk") throw new Error("Missing compiled image references");
      const urls = [...script.code.matchAll(/"(\/favicon\.ico\?v=[a-f0-9]{8}|\/[tl]?[a-f0-9]{8}\.(?:svg|png))"/g)].map(match => match[1]);
      expect(urls).toHaveLength(files.length);
      expect(script.code).toContain('"/icons/share-default.png"');
      expect(script.code).toContain('"/manifest.webmanifest"');
      for (const [index, url] of urls.entries()) {
        if (index === 0) continue;
        const asset = bundle.output.find(file => file.type === "asset" && file.fileName === url.slice(1));
        if (!asset || asset.type !== "asset") throw new Error(`Missing emitted image: ${url}`);
        expect(Buffer.from(asset.source)).toEqual(fs.readFileSync(path.join(directory, "public", files[index])));
      }
      return urls;
    };
    const before = await build();
    for (const [index, file] of files.entries()) {
      const target = path.join(directory, "public", file);
      const bytes = fs.readFileSync(target);
      fs.writeFileSync(target, Buffer.concat([bytes, Buffer.from("\n")]));
      const after = await build();
      expect(after[index], file).not.toBe(before[index]);
      for (const [at, url] of after.entries()) expect(url).not.toBe(before[at]);
      fs.writeFileSync(target, bytes);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

type Icon = { src: string; sizes: string; type: string; purpose?: string };
type Manifest = { id: string; name: string; short_name: string; start_url: string; scope: string; display: string; background_color: string; theme_color: string; lang?: string; icons: Icon[]; share_target?: { action: string; method: string; params: { title: string; text: string; url: string } } };
const manifest = () => JSON.parse(readPublic("manifest.webmanifest").toString("utf8")) as Manifest;

// Read PNG dimensions from IHDR: after the eight-byte signature come a four-byte length, "IHDR", four-byte width, and four-byte height.
function pngSize(file: Buffer): { width: number; height: number } {
  expect(file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "a PNG signature").toBe(true);
  expect(file.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
}

describe("the web app manifest", () => {
  it("opens the posting screen with title, text and URL parameters from an Android share", () => {
    expect(manifest().share_target).toEqual({
      action: "/t/new",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    });
  });

  it("is valid JSON that names the site tomola, starts at the root, and runs standalone", () => {
    const m = manifest();
    expect(m.name).toBe("tomola");
    expect(m.short_name).toBe("tomola");
    expect(m.id).toBe("/");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    // The manifest has one palette: use the light paper. lang is unset (the same name in every language).
    expect(m.background_color).toBe("#fbfaf7");
    expect(m.theme_color).toBe("#fbfaf7");
    expect(m.lang).toBeUndefined();
  });

  it("lists a 192 and a 512 icon, and a maskable 512 icon, each a PNG of the declared size at an existing path", () => {
    const { icons } = manifest();
    const bySrc = new Map(icons.map((i) => [i.src, i]));
    expect([...bySrc.keys()].sort()).toEqual(["/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"]);
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(readPublic(icon.src.slice(1)))).toEqual({ width: w, height: h });
    }
    expect(bySrc.get("/icons/icon-192.png")!.sizes).toBe("192x192");
    expect(bySrc.get("/icons/icon-512.png")!.sizes).toBe("512x512");
    expect(bySrc.get("/icons/icon-maskable-512.png")!.purpose).toBe("maskable");
    // Only maskable icons have purpose; the others use any.
    expect(icons.filter((i) => i.purpose !== undefined)).toHaveLength(1);
  });

  it("has an Apple touch icon of 180 x 180 and the source SVG of the icons", () => {
    expect(pngSize(readPublic("icons/apple-touch-icon.png"))).toEqual({ width: 180, height: 180 });
    expect(readPublic("icons/icon.svg").toString("utf8")).toContain("<svg");
  });

  it("keeps home-screen and share images on opaque paper, with the maskable and share marks inside their safe circles", async () => {
    const mark = await sharp(readPublic("icons/logomark.svg")).ensureAlpha().raw().toBuffer();
    expect(mark[3]).toBe(0);
    for (const [file, size, radius] of [["icon-192.png", 192, Infinity], ["icon-512.png", 512, Infinity], ["icon-maskable-512.png", 512, 512 * 0.4], ["apple-touch-icon.png", 180, Infinity], ["share-default.png", 512, 128]] as const) {
      const { data, info } = await sharp(readPublic(`icons/${file}`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([size, size]);
      let ink = 0;
      let outsideSafeCircle = 0;
      let transparent = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const pixel = (y * size + x) * 4;
        if (data[pixel + 3] !== 255) transparent++;
        if (data[pixel] < 250 || data[pixel + 1] < 250 || data[pixel + 2] < 250) {
          ink++;
          if (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > radius) outsideSafeCircle++;
        }
      }
      expect(transparent, file).toBe(0);
      expect(ink, file).toBeGreaterThan(size * size * 0.1);
      expect(outsideSafeCircle, file).toBe(0);
      expect([...data.subarray(0, 4)], file).toEqual([255, 255, 255, 255]);
    }
  });

  it("includes transparent legacy ICO frames at 16, 32 and 48 pixels", () => {
    const ico = readPublic("favicon.ico");
    expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 3, 0]);
    for (const [index, size] of [16, 32, 48].entries()) {
      const entry = 6 + index * 16;
      expect([...ico.subarray(entry, entry + 2)]).toEqual([size, size]);
      const offset = ico.readUInt32LE(entry + 12);
      const length = ico.readUInt32LE(entry + 8);
      const maskStride = Math.ceil(size / 32) * 4;
      expect(length).toBe(40 + size * size * 4 + maskStride * size);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      expect(ico.readUInt32LE(offset)).toBe(40);
      expect(ico.readInt32LE(offset + 4)).toBe(size);
      expect(ico.readInt32LE(offset + 8)).toBe(size * 2);
      expect(ico.readUInt16LE(offset + 14)).toBe(32);
      expect(ico.readUInt32LE(offset + 20)).toBe(size * size * 4);
      expect(ico[offset + 40 + 3]).toBe(0);
      expect(ico[offset + 40 + size * size * 4] & 0x80).toBe(0x80);
      const center = offset + 40 + (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
      expect(ico[center + 3]).toBe(255);
    }
  });

  it("regenerates every committed image from the replaceable tab mark and logomark", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-icons-"));
    const large = ["icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png", "icons/share-default.png"];
    const files = ["icons/badge-96.png", "favicon.ico", ...large];
    const square = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 0H512V512H0Z" fill="#123456"/></svg>';
    try {
      fs.mkdirSync(path.join(directory, "icons"));
      for (const file of ["icons/icon.svg", "icons/logomark.svg"]) fs.copyFileSync(path.join(publicDir, file), path.join(directory, file));
      await generateIcons(directory);
      for (const file of files) expect(fs.readFileSync(path.join(directory, file)).equals(readPublic(file)), file).toBe(true);
      fs.writeFileSync(path.join(directory, "icons/logomark.svg"), square);
      await generateIcons(directory);
      for (const file of large) expect(fs.readFileSync(path.join(directory, file)).equals(readPublic(file)), file).toBe(false);
      expect(fs.readFileSync(path.join(directory, "favicon.ico")).equals(readPublic("favicon.ico"))).toBe(true);
      const pixels = await sharp(path.join(directory, "icons/icon-maskable-512.png")).removeAlpha().raw().toBuffer();
      let outsideSafeCircle = 0;
      for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
        if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 512 * 0.4 && pixels[(y * 512 + x) * 3] < 250) outsideSafeCircle++;
      }
      expect(outsideSafeCircle).toBe(0);
      fs.writeFileSync(path.join(directory, "icons/icon.svg"), square);
      await generateIcons(directory);
      expect(fs.readFileSync(path.join(directory, "favicon.ico")).equals(readPublic("favicon.ico"))).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("is not the Markdown manifest: /manifest.json (the hashes of the Markdown twins) is another file", () => {
    expect(fs.existsSync(path.join(publicDir, "manifest.json"))).toBe(false);
  });
});

const messages = (locale: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Record<string, string>;
const callOffline = (init?: RequestInit) => offlineLoader({ request: new Request("https://tomola.example/offline", init), params: {}, context: undefined } as never) as Response;

describe("the offline page (/offline)", () => {
  it("is a public, script-free HTML document that is revalidated, with no cookie and no member data", async () => {
    const res = callOffline();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // Its own policy, with no nonce: the service worker keeps this document for a long time, so it must not carry the nonce of one request.
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("nonce");
    expect(res.headers.getSetCookie()).toEqual([]);
    const html = await res.text();
    const themes = [...html.matchAll(/<meta name="theme-color" media="([^"]+)" content="([^"]+)">/g)];
    expect(themes).toHaveLength(2);
    expect(themes.map(theme => theme[1])).toEqual(["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"]);
    const grounds = html.match(/background:light-dark\(([^,]+),([^)]+)\)/);
    expect(grounds).not.toBeNull();
    expect(themes.map(theme => theme[2])).toEqual(grounds!.slice(1));
    expect(themes[0][2]).toBe(manifest().theme_color);
    expect(html).toMatch(/^<!doctype html>\n<html lang="mul">/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<section(?![^>]*\blang=)[^>]*>/);
    expect(html).not.toMatch(/nonce|csrf|token|session/i);
    expect(html).not.toMatch(/<(form|input|img|link|iframe)\b/i);
    expect(html).not.toMatch(/(?:src|href)="(?!\/"|")/);
  });

  it("keeps its own headers when the security-headers middleware adds the others (it only adds the headers a response does not have)", () => {
    const own = callOffline();
    const wrapped = withSecurityHeaders(callOffline(), { nonce: "N0NCE", production: true });
    for (const name of ["content-security-policy", "referrer-policy", "cache-control", "content-type"]) expect(wrapped.headers.get(name), name).toBe(own.headers.get(name));
    expect(wrapped.headers.get("content-security-policy")).not.toContain("N0NCE");
    expect(wrapped.headers.get("x-content-type-options")).toBe("nosniff");
    expect(wrapped.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(wrapped.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("is the same document for every reader: it does not read the cookie or the language of the request", async () => {
    const plain = await callOffline().text();
    const asMember = await callOffline({ headers: { cookie: "better-auth.session_token=abc; PARAGLIDE_LOCALE=de", "accept-language": "de" } }).text();
    expect(asMember).toBe(plain);
  });

  it("says it in every language that has its own text (a language using English fallback is left out), each in a section with its own lang, with a link to the home page", async () => {
    const html = await callOffline().text();
    const en = messages("en");
    const ja = messages("ja");
    const keys = ["offline_title", "offline_body", "offline_home"];
    // Read from the message files, so that translating one more language does not need a change here.
    const own = LANGS.filter((lang) => lang === "en" || keys.some((key) => (messages(lang)[key] ?? en[key]) !== en[key]));
    expect(own).toEqual(expect.arrayContaining(["ja", "en"]));
    expect([...(html.match(/<section lang="[^"]+">/g) ?? [])].sort()).toEqual(own.map((lang) => `<section lang="${lang}">`).sort());
    for (const text of [ja.offline_title, ja.offline_body, ja.offline_home, en.offline_title, en.offline_body, en.offline_home]) expect(html).toContain(text);
    expect(html.match(/<a href="\/">/g)).toHaveLength(own.length);
    expect(html).toContain("<title>tomola</title>");
  });

  it("shows the sentences of the enabled languages only (ENABLED_LANGS), the same for every reader", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja");
    expect((await callOffline().text()).match(/<section lang="[^"]+">/g)).toEqual(['<section lang="ja">']);
    vi.stubEnv("ENABLED_LANGS", "en");
    expect((await callOffline().text()).match(/<section lang="[^"]+">/g)).toEqual(['<section lang="en">']);
    vi.unstubAllEnvs();
  });

  it("has the three messages in every one of the nine languages", () => {
    for (const lang of LANGS) for (const key of ["offline_title", "offline_body", "offline_home"]) expect(messages(lang)[key] ?? messages("en")[key], `${lang} ${key}`).toBeTruthy();
  });

  it("does not read the session, the database or the auth (the module imports none of them)", () => {
    for (const file of ["app/routes/offline.ts", "app/lib/offline-page.ts"]) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
      expect(imports.filter((i) => /auth|db|session|profiles|members|roles/.test(i)), file).toEqual([]);
    }
  });
});

describe("the sentences of the offline page", () => {
  const text = (lang: string, title: string): OfflineText => ({ lang, title, body: `${title} body`, home: `${title} home`, reload: `${title} reload` });

  it("skip a language whose sentences use English fallback, and show it once it is translated", () => {
    const en = text("en", "Offline");
    const placeholder = { ...en, lang: "fr" };
    expect(offlineSections([text("ja", "オフライン"), en, placeholder]).map((t) => t.lang)).toEqual(["ja", "en"]);
    expect(offlineSections([text("ja", "オフライン"), en, text("fr", "Hors ligne")]).map((t) => t.lang)).toEqual(["ja", "en", "fr"]);
    // List partially translated languages too, so their translated portions remain readable even when body text is English.
    expect(offlineSections([en, { ...placeholder, home: "Accueil" }]).map((t) => t.lang)).toEqual(["en", "fr"]);
  });

  it("keep only the enabled languages (ENABLED_LANGS) when they are given, even for a language that is translated", () => {
    const en = text("en", "Offline");
    const texts = [text("ja", "オフライン"), en, text("fr", "Hors ligne"), text("de", "Offline (de)")];
    expect(offlineSections(texts, ["ja", "en"]).map((t) => t.lang)).toEqual(["ja", "en"]);
    expect(offlineSections(texts, ["ja", "en", "fr"]).map((t) => t.lang)).toEqual(["ja", "en", "fr"]);
    expect(offlineSections(texts).map((t) => t.lang)).toEqual(["ja", "en", "fr", "de"]);
    expect(renderOfflinePage(texts, "tomola", ["ja"]).match(/<section lang="[^"]+">/g)).toEqual(['<section lang="ja">']);
  });

  it("are escaped in the HTML", () => {
    const html = renderOfflinePage([{ lang: "en", title: "a <b> & \"c\"", body: "<script>x</script>", home: "h", reload: "r" }], "t<i>");
    expect(html).toContain("a &lt;b&gt; &amp; &quot;c&quot;");
    expect(html).not.toContain("<script");
    expect(html).toContain("<title>t&lt;i&gt;</title>");
  });
});

// --- Service worker ---------------------------------------------------------------------------------------------------------------------------------
// Run public/sw.js unchanged in a fake environment with self, caches, and fetch, then dispatch events. Check both the cache allowlist and what must not be cached.
type FakeResponseInit = { status?: number; type?: string; body?: string };
const fakeResponse = ({ status = 200, type = "basic", body = "x" }: FakeResponseInit = {}): Response => {
  const res = new Response(status === 204 || status === 304 ? null : body, { status: status === 200 || status === 206 || status === 404 || status === 500 ? status : 200 });
  Object.defineProperty(res, "type", { value: type });
  return res;
};

const ORIGIN = "https://tomola.example";
type FetchEvent = { request: Request; respondWith(p: Promise<Response> | Response): void; waitUntil(p: Promise<unknown>): void };

function loadServiceWorker(network: (req: Request) => Promise<Response> | Response) {
  // Cache storage: cache name → (URL → response).
  const store = new Map<string, Map<string, Response>>();
  const fetched: Request[] = [];
  const cacheApi = (name: string) => {
    const entries = store.get(name) ?? store.set(name, new Map()).get(name)!;
    return {
      put: async (req: Request | string, res: Response) => {
        entries.set(typeof req === "string" ? req : req.url, res);
      },
      match: async (req: Request | string) => entries.get(typeof req === "string" ? new URL(req, ORIGIN).href : req.url)?.clone(),
      addAll: async (reqs: Request[]) => {
        for (const req of reqs) {
          const res = await fetchFn(req);
          if (!res.ok) throw new TypeError("bad response status");
          entries.set(req.url, res);
        }
      },
    };
  };
  const caches = {
    open: async (name: string) => cacheApi(name),
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  };
  const fetchFn = async (req: Request | string) => {
    const request = typeof req === "string" ? new Request(new URL(req, ORIGIN)) : req;
    fetched.push(request);
    return network(request);
  };
  const listeners: Record<string, (event: never) => void> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners[type] = listener;
    },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
    registration: { navigationPreload: { enable: vi.fn(async () => {}) } },
  };
  // Resolve new Request("/offline") inside the worker relative to the worker URL.
  class WorkerRequest extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init);
    }
  }
  vm.runInNewContext(versionServiceWorker(fs.readFileSync(path.join(publicDir, "sw.js"), "utf8"), "unit-build"), { self, caches, fetch: fetchFn, Request: WorkerRequest, Response, URL, Promise, TypeError });

  // Dispatch one event: await the response passed to respondWith, or handled=false if absent, and all waitUntil promises.
  async function dispatch(type: "install" | "activate" | "fetch", request?: Request, preloadResponse?: Promise<Response | undefined>): Promise<{ handled: boolean; response?: Response }> {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | Response | null = null;
    const event = { request, preloadResponse, respondWith: (p: Promise<Response> | Response) => (responded = p), waitUntil: (p: Promise<unknown>) => waits.push(p) } as FetchEvent;
    listeners[type](event as never);
    await Promise.all(waits);
    const response = responded ? await responded : undefined;
    return { handled: responded !== null, response };
  }
  const cachedUrls = () => [...store.values()].flatMap((entries) => [...entries.keys()]).map((url) => new URL(url).pathname + new URL(url).search);
  return { dispatch, store, fetched, self, listeners, cachedUrls };
}

const nav = (pathname: string) => {
  const req = new Request(`${ORIGIN}${pathname}`);
  Object.defineProperty(req, "mode", { value: "navigate" });
  return req;
};
const get = (pathname: string, origin = ORIGIN) => new Request(`${origin}${pathname}`);

describe("the service worker (public/sw.js)", () => {
  const source = versionServiceWorker(fs.readFileSync(path.join(publicDir, "sw.js"), "utf8"), "unit-build");

  it("handles visible push alongside caching without background sync or member storage", () => {
    const sw = loadServiceWorker(() => fakeResponse());
    expect(Object.keys(sw.listeners).sort()).toEqual(["activate", "fetch", "install", "notificationclick", "push"]);
    // Notifications do not add storage or background synchronization.
    const code = source.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/importScripts|\bsync\b|periodicsync|indexedDB|localStorage/);
    expect(source).toContain('const CACHE = "tomola-shell-unit-build";');
  });

  it("on install, stores the offline page and nothing else, fetched without cookies", async () => {
    const sw = loadServiceWorker((req) => (new URL(req.url).pathname === "/offline" ? fakeResponse({ body: "offline" }) : fakeResponse({ status: 404 })));
    await sw.dispatch("install");
    expect(sw.fetched.map((r) => new URL(r.url).pathname)).toEqual(["/offline"]);
    expect(sw.fetched[0].credentials).toBe("omit");
    expect(sw.cachedUrls()).toEqual(["/offline"]);
    expect([...sw.store.keys()]).toHaveLength(1);
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  it("on install, fails (and so is not installed) if the offline page cannot be fetched", async () => {
    const sw = loadServiceWorker(() => fakeResponse({ status: 500 }));
    await expect(sw.dispatch("install")).rejects.toThrow();
  });

  it("on activate, deletes every cache of another version and keeps its own", async () => {
    const sw = loadServiceWorker(() => fakeResponse());
    const version = /const CACHE = "([^"]+)"/.exec(source)![1];
    sw.store.set("tomola-shell-v0", new Map([["https://tomola.example/offline", fakeResponse()]]));
    sw.store.set("something-else", new Map());
    sw.store.set(version, new Map([["https://tomola.example/offline", fakeResponse()]]));
    await sw.dispatch("activate");
    expect([...sw.store.keys()]).toEqual([version]);
    expect(sw.self.clients.claim).toHaveBeenCalled();
    expect(sw.self.registration.navigationPreload.enable).toHaveBeenCalledExactlyOnceWith();
  });

  it("uses navigation preload without a duplicate document fetch or caching member HTML", async () => {
    const sw = loadServiceWorker(() => fakeResponse({ body: "offline" }));
    await sw.dispatch("install");
    const result = await sw.dispatch("fetch", nav("/t/1"), Promise.resolve(fakeResponse({ body: "preloaded member HTML" })));
    expect(await result.response!.text()).toBe("preloaded member HTML");
    expect(sw.fetched).toHaveLength(1);
    expect(sw.cachedUrls()).toEqual(["/offline"]);
  });

  it("serves a page navigation from the network and never stores it", async () => {
    const sw = loadServiceWorker(() => fakeResponse({ body: "<html>member page</html>" }));
    await sw.dispatch("install");
    for (const url of ["/", "/t/12", "/notifications", "/settings", "/following", "/t/12?lang=ja", "/login"]) {
      const { handled, response } = await sw.dispatch("fetch", nav(url));
      expect(handled, url).toBe(true);
      expect(await response!.text(), url).toBe("<html>member page</html>");
    }
    expect(sw.cachedUrls()).toEqual(["/offline"]);
  });

  it("shows the offline page when a navigation cannot reach the network, and a network error if even that is missing", async () => {
    let online = true;
    const sw = loadServiceWorker((req) => {
      if (new URL(req.url).pathname === "/offline" || online) return fakeResponse({ body: new URL(req.url).pathname === "/offline" ? "offline page" : "page" });
      throw new TypeError("Failed to fetch");
    });
    const noOffline = loadServiceWorker(() => {
      throw new TypeError("Failed to fetch");
    });
    await sw.dispatch("install");
    online = false;
    const { response } = await sw.dispatch("fetch", nav("/t/12"));
    expect(await response!.text()).toBe("offline page");
    expect((await noOffline.dispatch("fetch", nav("/t/12"))).response!.type).toBe("error");
  });

  it("passes a navigation that got a response through as it is, even a 404, a 500 or an opaque redirect: never the offline page, and nothing is stored", async () => {
    for (const init of [{ status: 404 }, { status: 500 }, { type: "opaqueredirect" }, { status: 206 }] as FakeResponseInit[]) {
      const sw = loadServiceWorker((req) => (new URL(req.url).pathname === "/offline" ? fakeResponse({ body: "offline page" }) : fakeResponse({ ...init, body: "network answer" })));
      await sw.dispatch("install");
      for (const url of ["/t/12", "/no-such-page", "/login"]) {
        const { handled, response } = await sw.dispatch("fetch", nav(url));
        expect(handled, `${url} ${JSON.stringify(init)}`).toBe(true);
        expect(response!.status, `${url} ${JSON.stringify(init)}`).toBe(init.status ?? 200);
        expect(response!.type, `${url} ${JSON.stringify(init)}`).toBe(init.type ?? "basic");
        expect(await response!.text(), `${url} ${JSON.stringify(init)}`).toBe("network answer");
      }
      expect(sw.cachedUrls(), JSON.stringify(init)).toEqual(["/offline"]);
    }
  });

  it("does not store a navigation to a built file either: only the subresource fetch of a hashed file is cached", async () => {
    const sw = loadServiceWorker(() => fakeResponse({ body: "console.log(1)" }));
    await sw.dispatch("install");
    const { handled, response } = await sw.dispatch("fetch", nav("/assets/entry.client-DhRNr3QZ.js"));
    expect(handled).toBe(true);
    expect(await response!.text()).toBe("console.log(1)");
    expect(sw.cachedUrls()).toEqual(["/offline"]);
  });

  it("caches a hashed file under /assets/ on the first request and serves it from the cache after that", async () => {
    const sw = loadServiceWorker((req) => fakeResponse({ body: `file ${new URL(req.url).pathname}` }));
    const first = await sw.dispatch("fetch", get("/assets/entry.client-DhRNr3QZ.js"));
    expect(first.handled).toBe(true);
    expect(await first.response!.text()).toBe("file /assets/entry.client-DhRNr3QZ.js");
    expect(sw.cachedUrls()).toEqual(["/assets/entry.client-DhRNr3QZ.js"]);
    expect(sw.fetched).toHaveLength(1);
    const again = await sw.dispatch("fetch", get("/assets/entry.client-DhRNr3QZ.js"));
    expect(await again.response!.text()).toBe("file /assets/entry.client-DhRNr3QZ.js");
    expect(sw.fetched).toHaveLength(1);
  });

  it("does not store an /assets/ response that is not a plain 200 of its own origin (a failure, a partial or an opaque response)", async () => {
    for (const init of [{ status: 404 }, { status: 500 }, { status: 206 }, { type: "opaque" }, { type: "cors" }, { type: "opaqueredirect" }] as FakeResponseInit[]) {
      const sw = loadServiceWorker(() => fakeResponse(init));
      const { handled } = await sw.dispatch("fetch", get("/assets/a-AAAAAAAA.js"));
      expect(handled, JSON.stringify(init)).toBe(true);
      expect(sw.cachedUrls(), JSON.stringify(init)).toEqual([]);
    }
  });

  it("leaves everything else to the browser: no respondWith, nothing stored (data requests, Markdown twins, APIs, other methods, other origins, files that only look like assets)", async () => {
    const sw = loadServiceWorker(() => fakeResponse({ body: "member data" }));
    await sw.dispatch("install");
    const untouched: Request[] = [
      get("/.data"),
      get("/t/12.data"),
      get("/_root.data"),
      get("/t/12.md"),
      get("/t/12.txt"),
      // the "Original" button of a home card (member data fetched with fetch: not a navigation, not under /assets/)
      get("/t/12/original"),
      get("/home.md"),
      get("/latest.md"),
      get("/search.md?q=a"),
      get("/changes.md"),
      get("/manifest.json"),
      get("/api/drafts"),
      get("/api/auth/get-session"),
      get("/api/openapi.json"),
      get("/mentions/suggest?q=a"),
      get("/preview"),
      get("/settings/export"),
      // The glossary twins and the YAML download (a download link: the worker must leave it to the network, so that the file is the server's, with its headers)
      get("/glossary.md"),
      get("/glossary.md?to=ja&k=signed"),
      get("/glossary.txt"),
      get("/glossary.yaml"),
      get("/offline"),
      get("/manifest.webmanifest"),
      get("/sw.js"),
      get("/icons/icon-192.png"),
      get("/favicon.ico"),
      get("/llms.txt"),
      get("/principles.md"),
      get("/principles.txt"),
      // Only hashed files directly under /assets/, without a query string, are the shell. A query string is part of the cache key, so these would store without limit.
      get("/assets/x-AAAAAAAA.js?n=1"),
      get("/assets/x-AAAAAAAA.js?k=s"),
      get("/assets/logo.png"),
      get("/assets/x.js"),
      get("/assets/x-short.js"),
      get("/assets/sub/x-AAAAAAAA.js"),
      get("/assets/x-AAAAAAAA"),
      get("/assets/"),
      get("/assetsx/a.js"),
      get("/static/assets/a.js"),
      get("/assets", ORIGIN),
      get("/assets/a-AAAAAAAA.js", "https://cdn.example.net"),
      new Request(`${ORIGIN}/assets/a-AAAAAAAA.js`, { method: "POST", body: "x" }),
      new Request(`${ORIGIN}/vote`, { method: "POST", body: "x" }),
    ];
    for (const req of untouched) {
      const { handled } = await sw.dispatch("fetch", req);
      expect(handled, `${req.method} ${req.url}`).toBe(false);
    }
    expect(sw.cachedUrls()).toEqual(["/offline"]);
    // The only fetch was /offline during install; event handling did not touch the network.
    expect(sw.fetched.map((r) => new URL(r.url).pathname)).toEqual(["/offline"]);
  });

  it("after any mix of requests, the cache holds only /assets/ files and the offline page", async () => {
    const sw = loadServiceWorker((req) => fakeResponse({ body: req.url }));
    await sw.dispatch("install");
    const requests = [nav("/"), nav("/t/1"), get("/assets/a-AAAAAAAA.js"), get("/assets/b-BBBBBBBB.css"), get("/t/1.data"), get("/t/1.md"), get("/api/drafts"), nav("/logout"), get("/assets/KaTeX_Main-Bold-Cx986IdX.woff2")];
    for (const req of requests) await sw.dispatch("fetch", req);
    expect(sw.cachedUrls().sort()).toEqual(["/assets/KaTeX_Main-Bold-Cx986IdX.woff2", "/assets/a-AAAAAAAA.js", "/assets/b-BBBBBBBB.css", "/offline"]);
  });
});

describe("the registration of the service worker", () => {
  it("registers from the root after the effect, only in secure production browsers, and tolerates failure", async () => {
    const register = vi.fn(() => Promise.reject(new Error("unsupported")));
    try {
      for (const [production, secure, supported] of [[false, true, true], [true, false, true], [true, true, false], [true, true, true]]) {
        vi.stubEnv("PROD", production);
        vi.stubGlobal("window", { isSecureContext: secure });
        vi.stubGlobal("navigator", supported ? { serviceWorker: { register } } : {});
        effects.length = 0;
        register.mockClear();
        expect(PwaRegistration()).toBeNull();
        expect(register).not.toHaveBeenCalled();
        expect(effects).toHaveLength(2);
        effects[0]();
        await Promise.resolve();
        if (production && secure && supported) {
          expect(register).toHaveBeenCalledExactlyOnceWith("/sw.js", { scope: "/" });
        } else expect(register).not.toHaveBeenCalled();
      }
    } finally {
      effects.length = 0;
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});

describe("the Content-Security-Policy for the service worker and the manifest", () => {
  it("allows the worker and the manifest from the site's own origin, and relaxes nothing else", () => {
    const directives = Object.fromEntries(contentSecurityPolicy("n").split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
    expect(directives["worker-src"]).toBe("'self'");
    expect(directives["manifest-src"]).toBe("'self'");
    expect(directives["script-src"]).toBe("'self' 'nonce-n'");
    expect(directives["default-src"]).toBe("'self'");
    expect(directives["connect-src"]).toBe("'self'");
    expect(contentSecurityPolicy("n")).not.toMatch(/unsafe-eval|blob:|\*/);
  });
});

describe("the headers of the static files that the app installs from", () => {
  const server = express();
  const env = { NODE_ENV: "production" };
  server.use(express.static(publicDir, { maxAge: "1h", setHeaders: (res, file) => setStaticHeaders(res, publicDir, file, env) }));
  const listening = new Promise<string>((resolve) => {
    const s = server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    afterAll(() => new Promise<void>((done) => s.close(() => done())));
  });

  it("serve /sw.js as JavaScript that is revalidated every time, never cached for an hour", async () => {
    const res = await fetch(`${await listening}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^(text|application)\/javascript/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(res.headers.get("etag")).toBeTruthy();
    // The script of the worker carries the CSP of the worker itself: its own origin only.
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(await res.text()).toBe(fs.readFileSync(path.join(publicDir, "sw.js"), "utf8"));
  });

  it("serve /manifest.webmanifest as application/manifest+json, revalidated, and not as the Markdown manifest", async () => {
    const res = await fetch(`${await listening}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/manifest\+json/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(JSON.parse(await res.text())).toEqual(manifest());
  });

  it("keep the other static files at one hour (the icons), and never immutable", async () => {
    const res = await fetch(`${await listening}/icons/icon-192.png`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("revalidate exactly the service worker and the manifest", () => {
    expect([...REVALIDATED_STATIC_PATHS].sort()).toEqual(["/manifest.webmanifest", "/sw.js"]);
  });
});

it("generates a monochrome transparent notification badge from the tab mark", async () => {
  const { data, info } = await sharp(readPublic("icons/badge-96.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([96, 96]);
  expect(data[(48 * info.width + 48) * 4 + 3]).toBe(0);
  let ink = 0; let transparent = 0;
  for (let at = 0; at < data.length; at += 4) {
    if (!data[at + 3]) transparent++;
    else { ink++; expect([...data.subarray(at, at + 3)]).toEqual([255, 255, 255]); }
  }
  expect(ink).toBeGreaterThan(100); expect(transparent).toBeGreaterThan(100);
});
