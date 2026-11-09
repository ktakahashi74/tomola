import { generateRequestDetails } from "web-push";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { pushEndpoint, publicPushAddress, validateSubscription } from "./endpoint.server";
import { pushConfig } from "./config.server";

export type PushSendResult = { kind: "accepted" | "gone" | "retry" | "operator"; retryAfterSeconds?: number };
export type PushSender = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: { ttl: number; topic: string }) => Promise<PushSendResult>;
export function retryAfterSeconds(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d{1,9}$/.test(value)) return Math.max(1, Number(value));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : undefined;
}
export function classifyPushResponse(status: number, retryAfter?: string): PushSendResult {
  if (status >= 200 && status < 300) return { kind: "accepted" };
  if (status === 404 || status === 410) return { kind: "gone" };
  if (status === 429 || status >= 500) return { kind: "retry", retryAfterSeconds: status === 429 ? retryAfterSeconds(retryAfter) : undefined };
  // Redirects, authentication failures and malformed messages are operator
  // failures. Never disable every recipient because of a bad VAPID setting.
  return { kind: "operator" };
}

type PostInput = { url: URL; address: string; headers: Record<string, string | number>; body: Buffer; signal: AbortSignal };
export class PushConnectionError extends Error {}
async function post(input: PostInput): Promise<{ status: number; retryAfter?: string }> {
  return new Promise((resolve, reject) => {
    let connected = false;
    // Connect to the already validated address. TLS still authenticates the
    // provider's hostname; no second DNS lookup, proxy or redirect is possible.
    const req = request({ hostname: input.address, servername: input.url.hostname, port: 443, path: input.url.pathname + input.url.search,
      method: "POST", agent: false, headers: { ...input.headers, Host: input.url.host }, signal: input.signal }, res => {
      resolve({ status: res.statusCode ?? 500, retryAfter: typeof res.headers["retry-after"] === "string" ? res.headers["retry-after"] : undefined });
      res.destroy();
    });
    req.on("socket", socket => socket.once("secureConnect", () => { connected = true; }));
    req.on("error", () => reject(connected ? new Error("Push transport failed") : new PushConnectionError("Push connection failed")));
    req.end(input.body);
  });
}
export function createPushSender(deps: { resolve?: typeof lookup; post?: typeof post } = {}): PushSender {
  return async (subscription, payload, options) => {
    try {
      let config;
      try { config = pushConfig(); } catch { return { kind: "operator" }; }
      if (!config) return { kind: "operator" };
      validateSubscription(subscription);
      const url = pushEndpoint(subscription.endpoint);
      if (Buffer.byteLength(payload) > 2048 || !/^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) return { kind: "operator" };
      const signal = AbortSignal.timeout(10_000);
      const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
        const aborted = () => reject(new Error("Push lookup timeout"));
        signal.addEventListener("abort", aborted, { once: true });
        (deps.resolve ?? lookup)(url.hostname, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      });
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !publicPushAddress(item.address))) return { kind: "operator" };
      let details;
      try { details = generateRequestDetails(subscription, payload, { TTL: Math.max(0, Math.min(7200, Math.floor(options.ttl))), urgency: "normal", topic: options.topic,
        contentEncoding: "aes128gcm", vapidDetails: config }); } catch { return { kind: "operator" }; }
      for (const { address } of addresses) {
        if (signal.aborted) break;
        try {
          const result = await (deps.post ?? post)({ url, address, headers: details.headers, body: details.body, signal });
          return classifyPushResponse(result.status, result.retryAfter);
        } catch (error) {
          // After TLS connects, the provider may already have received the body.
          if (!(error instanceof PushConnectionError)) break;
        }
      }
      return { kind: "retry" };
    } catch {
      // Upstream errors can contain endpoints, keys and response bodies. Return
      // only an allowlisted outcome; never propagate them to logs or queue state.
      return { kind: "retry" };
    }
  };
}
export const sendWebPush = createPushSender();
