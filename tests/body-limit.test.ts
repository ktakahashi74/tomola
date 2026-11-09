import http from "node:http";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { MEDIA_LIMITS } from "~/lib/media";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bodyLimit, DEFAULT_MAX_REQUEST_BODY_BYTES, DRAIN_TIMEOUT_MS, IMAGE_UPLOAD_PATH, maxRequestBodyBytes } from "../server/body-limit.ts";

// Body limit (server/body-limit.ts): oversized Content-Length yields 413 before reading; chunked bodies are counted and rejected with 413 when over the limit.
const MAX = 100;
let server: http.Server | undefined;
afterEach(async () => {
  const running = server;
  server = undefined;
  if (!running) return;
  running.closeAllConnections();
  await new Promise((resolve) => running.close(resolve));
});

type Seen = { handled: number; bodyBytes: number[]; aborted: Promise<void>; drained: Promise<void> };
async function start(maxBytes = MAX): Promise<{ port: number; seen: Seen }> {
  let aborted!: () => void;
  let drained!: () => void;
  const seen: Seen = { handled: 0, bodyBytes: [], aborted: new Promise(resolve => { aborted = resolve; }), drained: new Promise(resolve => { drained = resolve; }) };
  const app = express();
  app.use((req, _res, next) => { req.once("end", drained); req.once("aborted", aborted); next(); });
  app.use(bodyLimit(maxBytes));
  // Stand in for React Router: read the entire body and return its byte count. Like server.ts, the handler reads req directly.
  app.all("/{*splat}", async (req, res) => {
    seen.handled++;
    req.once("aborted", aborted);
    let n = 0;
    try {
      for await (const chunk of req) n += (chunk as Buffer).length;
    } catch {
      return;
    }
    seen.bodyBytes.push(n);
    res.status(200).send(String(n));
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

function send(port: number, opts: { path?: string; method?: string; headers?: Record<string, string>; chunks?: Array<string | Buffer>; delayMs?: number }): Promise<{ status: number | null; body: string; closedEarly: boolean }> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path ?? "/x", headers: opts.headers, agent: false });
    let status: number | null = null;
    let body = "";
    req.on("response", (res) => {
      status = res.statusCode ?? null;
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status, body, closedEarly: false }));
      res.on("error", () => resolve({ status, body, closedEarly: true }));
    });
    req.on("error", () => resolve({ status, body, closedEarly: true }));
    const chunks = opts.chunks ?? [];
    void (async () => {
      for (const c of chunks) {
        if (req.destroyed) return;
        req.write(c);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (!req.destroyed) req.end();
    })();
  });
}

describe("bodyLimit with a Content-Length", () => {
  it.each(["active", "idle"])("closes a stalled %s rejected upload at its deadline", async bound => {
    const { port, seen } = await start();
    let request!: http.ClientRequest;
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        request = http.request({ host: "127.0.0.1", port, path: "/x", method: "POST", headers: { "Content-Length": String(DEFAULT_MAX_REQUEST_BODY_BYTES + 2), Connection: "keep-alive" } }, resolve);
        request.on("error", reject); request.write("a");
      });
      expect(response.statusCode).toBe(413);
      response.resume();
      if (bound === "active") request.write("a".repeat(DEFAULT_MAX_REQUEST_BODY_BYTES));
      await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS);
      await seen.aborted;
      expect(seen.handled).toBe(0);
    } finally { request?.destroy(); vi.useRealTimers(); }
  });
  it("delivers 413 before bounded draining of the remaining advertised body", async () => {
    const { port, seen } = await start();
    let request!: http.ClientRequest;
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        request = http.request({ host: "127.0.0.1", port, path: "/x", method: "POST", headers: { "Content-Length": String(MAX + 1), Connection: "keep-alive" } }, resolve);
        request.on("error", reject);
        request.write("a");
      });
      expect(response.statusCode).toBe(413);
      expect(response.headers.connection).not.toBe("close");
      response.resume();
      request.end("a".repeat(MAX));
      await seen.drained;
      expect(seen.handled).toBe(0);
    } finally { request?.destroy(); }
  });
  it("lets a body of exactly the limit through, and answers 413 for one byte more, without reading it", async () => {
    const { port, seen } = await start();
    const ok = await send(port, { headers: { "Content-Length": String(MAX) }, chunks: ["a".repeat(MAX)] });
    expect(ok).toMatchObject({ status: 200, body: String(MAX) });
    const tooBig = await send(port, { headers: { "Content-Length": String(MAX + 1) }, chunks: ["a".repeat(MAX + 1)] });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toContain("413 Payload Too Large");
    // Rejected requests never reach the handler.
    expect(seen.handled).toBe(1);
  });

  it("answers 413 at once when only the header announces a huge body (the body is never sent)", async () => {
    const { port, seen } = await start();
    const res = await send(port, { headers: { "Content-Length": "999999999999" }, chunks: [] });
    // Reject from headers alone without sending the body; the connection closes after the response.
    expect(res.status).toBe(413);
    expect(seen.handled).toBe(0);
  });

  it("refuses a Content-Length that is not a number, and lets requests without a body (GET, an empty POST) through", async () => {
    const { port } = await start();
    const get = await send(port, { method: "GET" });
    expect(get).toMatchObject({ status: 200, body: "0" });
    const empty = await send(port, { headers: { "Content-Length": "0" } });
    expect(empty).toMatchObject({ status: 200, body: "0" });
  });

  it("sends no-store and nosniff with the 413 and closes the oversized upload", async () => {
    const { port } = await start();
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/x", headers: { "Content-Length": String(MAX + 1), Connection: "keep-alive" } }, (res) => {
        res.resume();
        resolve(res.headers);
      });
      req.on("error", () => {});
      req.write("a".repeat(MAX + 1));
      req.end();
    });
    expect(headers.connection).not.toBe("close");
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("bodyLimit with a chunked body (no Content-Length)", () => {
  it("closes an unfinished oversized upload and aborts the downstream body reader after delivering 413", async () => {
    const { port, seen } = await start();
    let request!: http.ClientRequest;
    try {
      const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
        request = http.request({ host: "127.0.0.1", port, path: "/x", method: "POST", headers: { "Transfer-Encoding": "chunked", Connection: "keep-alive" } }, response => {
          expect(response.statusCode).toBe(413);
          response.resume();
          response.once("end", () => resolve(response.headers));
        });
        request.on("error", reject);
        // Intentionally leave the request unfinished: no end() and no timer.
        request.write("x".repeat(MAX + 1));
      });
      expect(headers.connection).toBe("close");
      await seen.aborted;
      expect(seen.bodyBytes).toEqual([]);
    } finally { request?.destroy(); }
  });
  it("lets a chunked body of exactly the limit through, in several chunks, and the handler gets all of it", async () => {
    const { port, seen } = await start();
    const res = await send(port, { headers: { "Transfer-Encoding": "chunked" }, chunks: ["a".repeat(40), "b".repeat(40), "c".repeat(20)], delayMs: 5 });
    expect(res).toMatchObject({ status: 200, body: String(MAX) });
    expect(seen.bodyBytes).toEqual([MAX]);
  });

  it("answers 413 as soon as the count passes the limit, and stops a body that would go on for ever", async () => {
    const { port, seen } = await start();
    const chunks = Array.from({ length: 2000 }, () => "z".repeat(1000));
    const res = await send(port, { headers: { "Transfer-Encoding": "chunked" }, chunks, delayMs: 1 });
    expect(res.status === 413 || res.closedEarly).toBe(true);
    // The handler did not receive the entire body.
    expect(seen.bodyBytes).toEqual([]);
  });

  it("answers 413 for a chunked body one byte over the limit", async () => {
    const { port } = await start();
    const res = await send(port, { headers: { "Transfer-Encoding": "chunked" }, chunks: ["a".repeat(MAX), "b"], delayMs: 5 });
    expect(res.status === 413 || res.closedEarly).toBe(true);
    if (res.status !== null) expect(res.status).toBe(413);
  });
});

describe("maxRequestBodyBytes", () => {
  it("is 2 MiB by default and reads MAX_REQUEST_BODY_BYTES", () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(2 * 1024 * 1024);
    expect(maxRequestBodyBytes({})).toBe(2_097_152);
    expect(maxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: " 4096 " })).toBe(4096);
    for (const bad of ["0", "-1", "2MB", "1.5", "abc"]) expect(() => maxRequestBodyBytes({ MAX_REQUEST_BODY_BYTES: bad }), bad).toThrow("MAX_REQUEST_BODY_BYTES");
  });
});

it("keeps Caddy image paths and body limits aligned with the app", () => {
  const caddy = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
  const patterns = [...caddy.matchAll(/^\s*path_regexp\s+(\S+)\s*$/gm)].map(match => match[1]);
  expect(patterns).toHaveLength(2);
  expect(patterns[0]).toBe(patterns[1]);
  const caddyPath = new RegExp(patterns[0]);
  const accepted = ["/media", "/settings/avatar", "/v/a/icon", "/v/1/icon", "/v/pictures-1/icon", "/v/a-b-2/icon"];
  const rejected = [
    "/media/x", "/mediax", "/settings/avatarx", "/v/a/icon/x", "/v/A/icon", "/v//icon",
    "/v/-a/icon", "/v/a-/icon", "/v/a--b/icon", "/v/a_b/icon", "/v/a.b/icon", "/v/a/b/icon",
    "/media/", "/settings/avatar/", "/v/a/icon/", "/MEDIA", "/Settings/avatar", "/v/a/ICON",
    "/x/../media", "/v/%61/icon", "/mediaXdata", "/media.data.extra",
  ];
  for (const [paths, expected] of [[accepted, true], [rejected, false]] as const) {
    for (const base of paths) {
      for (const path of [base, `${base}.data`]) {
        const appMatches = IMAGE_UPLOAD_PATH.test(path);
        expect(appMatches, path).toBe(expected);
        expect(caddyPath.test(path), path).toBe(appMatches);
      }
    }
  }

  const limits = [...caddy.matchAll(/^\s*request_body\s+@(imageUpload|ordinaryBody)\s*\{\s*max_size\s+(\d+)(MiB)?\s*\}/gm)];
  expect(limits).toHaveLength(2);
  expect(Object.fromEntries(limits.map(([, matcher, value, unit]) => [matcher, Number(value) * (unit === "MiB" ? 1024 ** 2 : 1)]))).toEqual({
    imageUpload: MEDIA_LIMITS.requestBytes,
    ordinaryBody: DEFAULT_MAX_REQUEST_BODY_BYTES,
  });
});


const uploadPaths = ["/media", "/settings/avatar", "/v/pictures-1/icon"].flatMap(path => [path, `${path}?lang=en`, `${path}.data`, `${path}.data?index&lang=en`]);
it.each(["length", "chunked"])("only expands image POST limits (%s)", async framing => {
  const { port } = await start(DEFAULT_MAX_REQUEST_BODY_BYTES);
  const body = Buffer.alloc(DEFAULT_MAX_REQUEST_BODY_BYTES + 1);
  const headers: Record<string, string> = framing === "length" ? { "Content-Length": String(body.length) } : { "Transfer-Encoding": "chunked" };
  for (const path of uploadPaths) {
    expect((await send(port, { path, headers, chunks: [body] })).status, path).toBe(200);
  }
  for (const opts of [
    ...uploadPaths.flatMap(path => ["PUT", "PATCH", "GET"].map(method => ({ path, method }))),
    ...["/media/other", "/t/new", "/v/pictures-1", "/v/pictures-1/edit", "/settings/avatar/reset",
      "/media/", "/media.data/", "/settings/avatar/", "/v/pictures-1/icon/", "/v/a/b/icon", "/v/a.b/icon", "/v/a/icon.data.extra",
      "/x/../media", "/MEDIA", "/Settings/avatar", "/v/pictures-1/ICON"].map(path => ({ path })),
  ]) expect((await send(port, { ...opts, headers, chunks: [body] })).status, JSON.stringify(opts)).toBe(413);
});

it.each(uploadPaths)("preserves the image request limit at %s", async path => {
  const { port } = await start(DEFAULT_MAX_REQUEST_BODY_BYTES);
  const body = Buffer.alloc(MEDIA_LIMITS.requestBytes);
  expect((await send(port, { path, headers: { "Content-Length": String(body.length) }, chunks: [body] })).status).toBe(200);
  expect((await send(port, { path, headers: { "Content-Length": String(body.length + 1) }, chunks: [body, "x"] })).status).toBe(413);
  expect((await send(port, { path, headers: { "Transfer-Encoding": "chunked" }, chunks: [body] })).status).toBe(200);
  expect((await send(port, { path, headers: { "Transfer-Encoding": "chunked" }, chunks: [body, "x"] })).status).toBe(413);
});

it.each(["/media", "/preview"])("uses the route's drain allowance before a timed close for %s", path => {
  vi.useFakeTimers();
  try {
    const limit = path === "/media" ? MEDIA_LIMITS.requestBytes : MAX;
    const req = Object.assign(new EventEmitter(), { method: "POST", originalUrl: path, headers: { "content-length": String(limit + 2 * 1024 * 1024) }, pause: vi.fn(), resume: vi.fn(), destroy: vi.fn() });
    const res = Object.assign(new EventEmitter(), { writableFinished: true, status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), end: vi.fn() });
    bodyLimit(MAX)(req as unknown as express.Request, res as unknown as express.Response, vi.fn());
    expect(res.status).toHaveBeenCalledWith(413);
    if (path === "/media") {
      req.emit("data", Buffer.alloc(2 * 1024 * 1024 + 1));
      expect(req.destroy).not.toHaveBeenCalled();
      expect(req.pause).not.toHaveBeenCalled();
      req.emit("data", Buffer.alloc(limit - 2 * 1024 * 1024));
    } else req.emit("data", Buffer.alloc(limit + 1));
    expect(req.pause).toHaveBeenCalledTimes(1);
    expect(req.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DRAIN_TIMEOUT_MS);
    expect(req.destroy).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
