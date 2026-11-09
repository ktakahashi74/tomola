// Request-body size limit, installed by production server.ts before the React Router handler.
// Form validation enforces post limits such as 50000 body characters only after reading the whole body into memory. An unbounded body could exhaust memory first.
// Reject Content-Length above the limit with 413 Payload Too Large before reading. Without Content-Length (Transfer-Encoding: chunked), count incoming bytes and
// return 413 when the limit is exceeded. Stop the incoming stream and close the connection after flushing the rejection, including when a chunked upload never finishes.
// MAX_REQUEST_BODY_BYTES is in bytes, default 2 MiB. Apply the same upstream Caddy limit in deploy/Caddyfile request_body.
import { MEDIA_LIMITS } from "../app/lib/media.ts";
import type { NextFunction, Request, Response } from "express";

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export function maxRequestBodyBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MAX_REQUEST_BODY_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (!/^\d{1,12}$/.test(raw) || Number(raw) < 1) throw new Error("MAX_REQUEST_BODY_BYTES must be a positive integer (bytes)");
  return Number(raw);
}

const MESSAGE = "413 Payload Too Large\n";
export const DRAIN_TIMEOUT_MS = 10_000;

// Match only image actions, including React Router's fetcher URLs. Ignore the
// query without normalizing the path into a different upload route.
export const IMAGE_UPLOAD_PATH = /^\/(?:media|settings\/avatar|v\/[a-z0-9]+(?:-[a-z0-9]+)*\/icon)(?:\.data)?$/;

// A known oversized body may already be in transit through a proxy. Send 413
// without Connection: close, which would let Node close before draining it.
function rejectKnownLength(req: Request, res: Response, drainMaxBytes: number): void {
  res.status(413).set({ "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(Buffer.byteLength(MESSAGE)), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  res.end(MESSAGE);
  let drained = 0;
  let ended = false;
  const closeWhenFlushed = () => { if (ended && res.writableFinished) req.destroy(); };
  res.once("finish", closeWhenFlushed);
  const timer = setTimeout(() => req.destroy(), DRAIN_TIMEOUT_MS);
  timer.unref();
  req.on("data", chunk => {
    drained += Buffer.byteLength(chunk);
    // Beyond the route's allowance, apply backpressure and let the deadline
    // close the connection. Immediate destruction can discard the 413 in a proxy.
    if (drained > drainMaxBytes && drained < Number(req.headers["content-length"])) req.pause();
  });
  req.once("end", () => { ended = true; clearTimeout(timer); closeWhenFlushed(); });
  req.once("close", () => clearTimeout(timer));
  req.resume();
}

// Stop downstream consumption at once. Flush the 413 before destroying the
// request, so ordinary clients still receive the rejection status and body.
function reject(req: Request, res: Response): void {
  if (res.headersSent || res.writableEnded) return;
  req.pause();
  req.unpipe();
  res.status(413).set({ "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(Buffer.byteLength(MESSAGE)), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", Connection: "close" });
  res.end(MESSAGE, () => req.destroy());
}

export function bodyLimit(maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.originalUrl.split("?", 1)[0];
    const limit = req.method === "POST" && IMAGE_UPLOAD_PATH.test(path) ? MEDIA_LIMITS.requestBytes : maxBytes;
    const length = req.headers["content-length"];
    if (length !== undefined) {
      // With an in-limit Content-Length, HTTP framing prevents extra bytes from reaching the handler as body data.
      if (/^\d+$/.test(length) && Number(length) <= limit) return next();
      return rejectKnownLength(req, res, limit);
    }
    if (req.headers["transfer-encoding"] === undefined) return next();
    // Without Content-Length, count chunked incoming data. Install this middleware immediately before React Router so its subscription begins in the same tick as the handler's
    // and both receive data from the first chunk.
    let received = 0;
    const onData = (chunk: Buffer | string) => {
      received += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (received > limit) {
        req.off("data", onData);
        reject(req, res);
      }
    };
    req.on("data", onData);
    next();
  };
}
