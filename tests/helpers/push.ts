import { randomBytes, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { session } from "~/lib/db/schema";
import type { Db } from "~/lib/db/client.server";
import { generateVapidKeys } from "~/lib/push/config.server";
export const pushKeys = generateVapidKeys;
export function configurePush() {
  const keys = pushKeys();
  vi.stubEnv("WEB_PUSH", "1"); vi.stubEnv("VAPID_PUBLIC_KEY", keys.publicKey); vi.stubEnv("VAPID_PRIVATE_KEY", keys.privateKey); vi.stubEnv("VAPID_SUBJECT", "mailto:push@example.org");
  return keys;
}
export const identity = () => ({ id: randomUUID(), secret: randomBytes(32).toString("base64url") });
export function subscription() { return { endpoint: `https://fcm.googleapis.com/wp/${randomUUID()}`, keys: { p256dh: pushKeys().publicKey, auth: randomBytes(16).toString("base64url") } }; }
export async function pushAuthorization(db: Db, userId: string, now = new Date()) {
  const id = randomUUID(); const expiresAt = new Date(now.getTime() + 86400000);
  await db.insert(session).values({ id, userId, token: randomUUID(), expiresAt });
  return { sessionId: id, expiresAt };
}
