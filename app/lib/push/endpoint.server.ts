import { BlockList, isIP } from "node:net";
import { createECDH } from "node:crypto";
import { z } from "zod";

// Exact provider hosts; only Microsoft's regional shards have a bounded subdomain pattern. No arbitrary provider suffixes.
export function pushEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid push subscription"); }
  const host = url.hostname;
  const allowed = ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"].includes(host)
    || /^(?:[a-z0-9][a-z0-9-]{0,61}\.)?notify\.windows\.com$/.test(host);
  if (value.length > 2048 || url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !allowed || url.pathname === "/") throw new Error("Invalid push subscription");
  return url;
}

const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["192.88.99.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(ip, prefix, "ipv4");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");
export function publicPushAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, "ipv6");
}

export const browserIdentity = z.object({ id: z.string().uuid(), secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const subscriptionInput = z.object({
  endpoint: z.string().max(2048),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).strict(),
}).strict();
export function validateSubscription(input: unknown) {
  const result = subscriptionInput.safeParse(input);
  if (!result.success) throw new Error("Invalid push subscription");
  pushEndpoint(result.data.endpoint);
  try {
    const point = Buffer.from(result.data.keys.p256dh, "base64url");
    if (point.length !== 65 || point[0] !== 4 || Buffer.from(result.data.keys.auth, "base64url").toString("base64url") !== result.data.keys.auth) throw new Error();
    // ECDH rejects points outside the P-256 curve.
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys(); ecdh.computeSecret(point);
  } catch { throw new Error("Invalid push subscription"); }
  return result.data;
}
