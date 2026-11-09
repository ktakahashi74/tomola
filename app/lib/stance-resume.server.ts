import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getSessionCookie } from "better-auth/cookies";
import type { MiddlewareFunction } from "react-router";
import { authSecret } from "./auth/secret.server";
import { isPosition, type Position } from "./stances";

export const STANCE_RESUME_TTL_SECONDS = 180;
type Options = { secret?: string; now?: number };
const key = (secret: string) => createHash("sha256").update("tomola:stance-resume\0").update(secret).digest();
const name = (request: Request) => `${new URL(request.url).protocol === "https:" ? "__Secure-" : ""}tomola.stance-resume`;
const binding = (userId: string, session: string) => Buffer.from(JSON.stringify([userId, session]));
const values = (request: Request) => (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${name(request)}=`));
function cookie(request: Request, questionId: number, value: string, maxAge: number) {
  return `${name(request)}=${value}; Path=/t/${questionId}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

// Created only after consent succeeds. Encrypt the choice and bind it to both
// the member and their authenticated browser session; it never enters a URL.
export function stanceResumeCookie(request: Request, userId: string, questionId: number, position: Position, { secret = authSecret(), now = Date.now() }: Options = {}): string | null {
  const session = getSessionCookie(request);
  if (!session) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(binding(userId, session));
  const payload = JSON.stringify([questionId, position, Math.floor(now / 1000) + STANCE_RESUME_TTL_SECONDS]);
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return cookie(request, questionId, Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url"), STANCE_RESUME_TTL_SECONDS);
}

// The loader clears even an invalid cookie. A URL, a different session, or an
// expired/revoked consent cannot produce the completion notice.
export function consumeStanceResume(request: Request, userId: string | undefined, questionId: number, consented: boolean, { secret = authSecret(), now = Date.now() }: Options = {}): { position: Position | null; headers: Headers } {
  const prefix = `${name(request)}=`;
  const supplied = values(request);
  const headers = new Headers();
  if (supplied.length) headers.append("Set-Cookie", cookie(request, questionId, "", 0));
  const session = getSessionCookie(request);
  if (supplied.length !== 1 || supplied[0].length > 512 || !userId || !session || !consented) return { position: null, headers };
  try {
    const encoded = supplied[0].slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { position: null, headers };
    const value = Buffer.from(encoded, "base64url");
    if (value.length < 29 || value.toString("base64url") !== encoded) return { position: null, headers };
    const decipher = createDecipheriv("aes-256-gcm", key(secret), value.subarray(0, 12));
    decipher.setAAD(binding(userId, session));
    decipher.setAuthTag(value.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"));
    const seconds = Math.floor(now / 1000);
    if (Array.isArray(payload) && payload.length === 3 && payload[0] === questionId && isPosition(payload[1]) && Number.isSafeInteger(payload[2]) && payload[2] > seconds && payload[2] <= seconds + STANCE_RESUME_TTL_SECONDS) {
      return { position: payload[1], headers };
    }
  } catch { /* Untrusted, expired, or bound to another session. */ }
  return { position: null, headers };
}

export const stanceResumeMiddleware: MiddlewareFunction<Response> = async ({ request }, next) => {
  const response = await next();
  if (!(response instanceof Response) || !values(request).length) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
