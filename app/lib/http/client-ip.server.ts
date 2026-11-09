import { randomBytes } from "node:crypto";
import diagnosticsChannel from "node:diagnostics_channel";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import net from "node:net";

// Client IP for rate-limit keys. Obtain only through trusted paths; never use client-spoofable values.
//
// 1. Direct peer socket address: React Router, including react-router-serve and the dev server, provides only a Web Request,
//    without the socket address. Subscribe to Node's http.server.request.start diagnostics channel, emitted synchronously upon receipt before handlers,
//    through installSocketAddressHook (called at startup by app/lib/startup.server.ts). Set the internal header
//    x-tomola-socket-address to "<per-process random value>:<socket address>", overwriting any same-name client header.
//    The random value exists only inside the process. Reject spoofed headers on requests predating the hook or in environments without it, since the value will not match.
// 2. Trusted proxies (TRUSTED_PROXY_HOPS, default 0): for N > 0, use the Nth X-Forwarded-For element from the right. Proxies
//    append their peer address on the right; clients can spoof the left side. With N = 0, never read X-Forwarded-For.
//    If fewer than N elements exist or the chosen element is not an IP (misconfiguration or direct proxy-bypassing connection), use the socket address.
// Return null if neither is available, such as the first dev-server request without the hook. Callers then omit per-IP limits.
// Convert IPv4-mapped IPv6 (::ffff:a.b.c.d or hexadecimal ::ffff:7f00:1) to IPv4; round other IPv6 to /64, preventing evasion through address changes within a prefix.
// Strip ports from X-Forwarded-For elements such as 1.2.3.4:5678 and [2001:db8::1]:5678.

const SOCKET_HEADER = "x-tomola-socket-address";
const g = globalThis as { __tomolaSocketNonce?: string; __tomolaSocketHook?: boolean; __tomolaForwardedWarning?: boolean };

function nonce(): string {
  return (g.__tomolaSocketNonce ??= randomBytes(16).toString("hex"));
}

export function installSocketAddressHook(): void {
  if (g.__tomolaSocketHook) return;
  g.__tomolaSocketHook = true;
  diagnosticsChannel.subscribe("http.server.request.start", (message) => {
    try {
      const { request, socket } = message as { request: IncomingMessage; socket: Socket };
      request.headers[SOCKET_HEADER] = `${nonce()}:${socket.remoteAddress ?? ""}`;
    } catch {
      // Only loses the address used for rate limits; do not stop the request.
    }
  });
}

// TRUSTED_PROXY_HOPS: number of trusted reverse-proxy hops before the server, a nonnegative integer. Unset/empty means 0; throw for invalid values.
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 0;
  if (!/^\d{1,2}$/.test(raw)) {
    throw new Error("TRUSTED_PROXY_HOPS must be a non-negative integer (the number of reverse proxies in front of the server; 0 when clients connect directly)");
  }
  return Number(raw);
}

function socketAddress(headers: Headers): string | null {
  const value = headers.get(SOCKET_HEADER);
  const prefix = `${nonce()}:`;
  if (value === null || !value.startsWith(prefix)) return null;
  return value.slice(prefix.length) || null;
}

// Convert an IPv6 string, already validated by isIP === 6, into eight 16-bit values. Accept IPv4 endings such as ::ffff:1.2.3.4.
function ipv6Groups(ip: string): number[] | null {
  let text = ip;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill("0") : []), ...rest].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
}

// Normalize IP addresses for rate-limit keys. Null if not an IP.
// Strip ports some proxies include in X-Forwarded-For: IPv4 1.2.3.4:5678, IPv6 [2001:db8::1]:5678, or unported [2001:db8::1].
// Convert IPv4-mapped IPv6 (::ffff:1.2.3.4 or hexadecimal ::ffff:102:304) to IPv4; round other IPv6 to /64.
export function normalizeIp(raw: string): string | null {
  let text = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) text = bracketed[1];
  else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text);
    if (withPort) text = withPort[1];
  }
  const ip = text.replace(/%.*$/, "").toLowerCase();
  const family = net.isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return null;
  const groups = ipv6Groups(ip);
  if (groups === null) return null;
  if (groups.slice(0, 5).every((n) => n === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
}

// Warn once when X-Forwarded-For exists but TRUSTED_PROXY_HOPS is 0, disabling its use. If proxy deployment omits this setting,
// all clients share the proxy's IP and are collectively subject to one per-IP limit.
function warnForwardedIgnored(): void {
  if (g.__tomolaForwardedWarning) return;
  g.__tomolaForwardedWarning = true;
  console.warn("[client-ip] X-Forwarded-For is present but TRUSTED_PROXY_HOPS is 0, so it is ignored. Behind a reverse proxy, set TRUSTED_PROXY_HOPS to the number of proxies, or every visitor shares the proxy's address in the per-IP limits.");
}

export function clientAddress(source: Request | Headers, opts: { hops?: number } = {}): string | null {
  const headers = source instanceof Headers ? source : source.headers;
  const hops = opts.hops ?? trustedProxyHops();
  if (hops === 0 && opts.hops === undefined && headers.has("x-forwarded-for")) warnForwardedIgnored();
  if (hops > 0) {
    const forwarded = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (forwarded.length >= hops) {
      const ip = normalizeIp(forwarded[forwarded.length - hops]);
      if (ip !== null) return ip;
    }
  }
  const socket = socketAddress(headers);
  return socket === null ? null : normalizeIp(socket);
}
