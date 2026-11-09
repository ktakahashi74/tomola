import { createECDH } from "node:crypto";

export function webPushEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WEB_PUSH !== undefined && env.WEB_PUSH !== "" && env.WEB_PUSH !== "1") throw new Error("WEB_PUSH must be 1 or empty");
  return env.WEB_PUSH === "1";
}

/** Creates a VAPID key pair in the fixed-length form that `pushConfig` accepts. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const key = createECDH("prime256v1");
  key.generateKeys();
  // The private scalar can start with zero bytes, which getPrivateKey() drops; VAPID keys are always 32 bytes.
  const raw = key.getPrivateKey();
  const privateKey = Buffer.alloc(32);
  raw.copy(privateKey, privateKey.length - raw.length);
  return { publicKey: key.getPublicKey().toString("base64url"), privateKey: privateKey.toString("base64url") };
}

export function pushConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!webPushEnabled(env)) return null;
  const publicKey = env.VAPID_PUBLIC_KEY ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY ?? "";
  const subject = env.VAPID_SUBJECT ?? "";
  try {
    if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(privateKey)) throw new Error();
    const key = createECDH("prime256v1");
    key.setPrivateKey(Buffer.from(privateKey, "base64url"));
    if (key.getPublicKey().toString("base64url") !== publicKey) throw new Error();
    const contact = new URL(subject);
    if (subject.length > 512 || !["mailto:", "https:"].includes(contact.protocol) || contact.username || contact.password || contact.hash || !contact.pathname || (contact.protocol === "mailto:" && !/^[^\s@]+@[^\s@]+$/.test(contact.pathname))) throw new Error();
  } catch { throw new Error("Invalid Web Push VAPID keys or public contact (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT)"); }
  return { publicKey, privateKey, subject };
}
