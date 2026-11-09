// Production server (pnpm start; Node 26 strips types and runs node server.ts directly). A small Express server replacing react-router-serve to:
// - Redact secret URL components from access logs (server/access-log.ts: query strings and /invite/<token>). react-router-serve's morgan previously printed ?k=, ?q= and /auth/confirm?token= verbatim.
// - Import the server build before opening the port. Startup checks (app/lib/startup.server.ts: invalid configuration and fake engines) fail here and prevent startup.
// - Start background work such as the worker immediately after opening the port, without waiting for the first request.
// - On SIGTERM or SIGINT, close the HTTP server and stop the worker before exiting (server/shutdown.ts).
// - Serve hashed /assets files with a one-year immutable cache, other static files for one hour; also compress responses.
// Client IP handling is unchanged: app/lib/http/client-ip.server.ts reads the socket address through Node diagnostics channels and interprets X-Forwarded-For using TRUSTED_PROXY_HOPS.
// Set Express trust proxy to the hop count only when TRUSTED_PROXY_HOPS >= 1. Reflect X-Forwarded-Proto and X-Forwarded-Host supplied by the upstream TLS-terminating proxy, such as Caddy,
// in the request URL. Otherwise React Router constructs an http URL from the incoming connection, mismatching the browser's https Origin,
// and its action-origin CSRF check rejects all form submissions with 400 Bad Request. react-router-serve does the same.
// At 0 hops, with no proxy, do not trust client-forgeable X-Forwarded-* headers.
// Environment: PORT (default 3000), HOST (default all addresses), HTTP_SHUTDOWN_TIMEOUT_MS (maximum wait for in-flight requests at shutdown, default 10000),
// WORKER_SHUTDOWN_TIMEOUT_MS (maximum wait for running jobs, default 8000), MAX_REQUEST_BODY_BYTES (default 2 MiB). Docker stop_grace_period must exceed shutdown waits; docker-compose.yml uses 30 seconds.
// This file and server/ avoid the app alias ~/ and are typechecked with erasableSyntaxOnly (tsconfig.server.json).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import type { ServerBuild } from "react-router";
import { trustedProxyHops } from "./app/lib/http/client-ip.server.ts";
import { formatAccessLog } from "./server/access-log.ts";
import { describeBackground } from "./server/background.ts";
import { bodyLimit, maxRequestBodyBytes } from "./server/body-limit.ts";
import { createShutdown } from "./server/shutdown.ts";
import { setStaticHeaders } from "./server/static-headers.ts";

process.env.NODE_ENV ??= "production";
const log = (message: string) => console.log(`[server] ${message}`);

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d{1,7}$/.test(raw)) throw new Error(`${name} must be a non-negative integer (milliseconds)`);
  return Number(raw);
}

type Background = { readinessResponse: () => Promise<Response>; startBackgroundServices?: (opts: { signals?: boolean }) => { stop(): Promise<unknown> } | null; initializeMarkdown?: (opts?: { workerFile: string }) => Promise<unknown>; stopVillageChat?: () => void; stopMarkdown?: () => Promise<unknown> };

async function main() {
  const port = process.env.PORT?.trim() ? Number(process.env.PORT) : 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number (got "${process.env.PORT}")`);
  const host = process.env.HOST?.trim() || undefined;
  const httpGraceMs = positiveInt("HTTP_SHUTDOWN_TIMEOUT_MS", 10_000);
  const workerGraceMs = positiveInt("WORKER_SHUTDOWN_TIMEOUT_MS", 8_000);
  const maxBodyBytes = maxRequestBodyBytes(process.env);

  // Importing the server build runs startup checks, throwing here on failure.
  const buildPath = path.resolve(import.meta.dirname, process.env.BUILD_PATH ?? "build/server/index.js");
  const build = (await import(pathToFileURL(buildPath).href)) as ServerBuild;
  const background = build.entry.module as unknown as Background;
  await background.initializeMarkdown?.({ workerFile: path.resolve(import.meta.dirname, "server/markdown-worker.mjs") });
  // Static paths are relative to the project root at build time; resolve from this file, regardless of the startup working directory.
  const clientDir = path.resolve(import.meta.dirname, build.assetsBuildDirectory);

  const app = express();
  app.disable("x-powered-by");
  const hops = trustedProxyHops(process.env);
  if (hops > 0) app.set("trust proxy", hops);

  // Health check for Docker and proxies: no DB access and no access-log entry.
  app.get("/healthz", (_req, res) => {
    res.set({ "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" }).status(200).send("ok\n");
  });

  app.get("/readyz", async (_req, res) => {
    const response = await background.readinessResponse();
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.status(response.status).send(await response.text());
  });

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    let logged = false;
    const done = () => {
      if (logged) return;
      logged = true;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const length = res.getHeader("content-length");
      console.log(formatAccessLog({ method: req.method, url: req.originalUrl, status: res.statusCode, bytes: length === undefined ? null : Number(length), ms }));
    };
    res.on("finish", done);
    res.on("close", done);
    next();
  });

  app.use(compression());

  // Static non-HTML responses receive nosniff and production HSTS only (server/static-headers.ts). Production uses the app's predicate: NODE_ENV is neither development nor test.
  // Apply these only to static responses; the app sets headers, including CSP, on React Router responses itself (app/lib/http/security-headers.server.ts).
  // Applying globally would duplicate headers as "nosniff, nosniff". Static files get no CSP, which is irrelevant to non-document responses.
  // Do not long-cache /sw.js or its manifest; no-cache requires revalidation before use.
  const staticHeaders = (res: express.Response, file: string) => setStaticHeaders(res, clientDir, file, process.env);
  const publicPath = new URL(build.publicPath, "http://localhost").pathname;
  app.use(path.posix.join(publicPath, "assets"), express.static(path.join(clientDir, "assets"), { immutable: true, maxAge: "1y", setHeaders: staticHeaders }));
  app.use(publicPath, express.static(clientDir, { maxAge: "1h", setHeaders: staticHeaders }));

  // Request-body limit: MAX_REQUEST_BODY_BYTES, default 2 MiB, directly before the React Router handler (server/body-limit.ts).
  app.use(bodyLimit(maxBodyBytes));
  app.all("/{*splat}", createRequestHandler({ build, mode: process.env.NODE_ENV }));

  // Upstream proxies such as Caddy reuse Keep-Alive connections for a long time (Caddy defaults to two minutes). Keep them longer; otherwise a proxy may send to a closing connection and receive 502.
  const server = host ? app.listen(port, host) : app.listen(port);
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 130_000;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  log(`listening on ${host ?? "all addresses"}:${typeof address === "object" && address ? address.port : port} (NODE_ENV=${process.env.NODE_ENV})`);

  // Background workers: handle signals here, not in the worker.
  const hasStarter = typeof background.startBackgroundServices === "function";
  const worker = (hasStarter ? background.startBackgroundServices?.({ signals: false }) : null) ?? null;
  const status = describeBackground({ hasStarter, worker, env: process.env });
  log(status.level === "warn" ? `WARNING: ${status.message}` : status.message);

  const shutdown = createShutdown({
    server,
    stopWorker: async () => { await worker?.stop(); },
    stopChat: () => background.stopVillageChat?.(),
    stopParsing: async () => { await background.stopMarkdown?.(); },
    httpGraceMs,
    // Add headroom to the longer of the HTTP and worker shutdown grace periods.
    forceExitMs: Math.max(httpGraceMs, workerGraceMs) + 15_000,
    log,
    exit: (code) => process.exit(code),
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => shutdown.handle(signal));
}

main().catch((error: unknown) => {
  // Startup configuration failures do not need a stack trace.
  console.error("[server] failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
