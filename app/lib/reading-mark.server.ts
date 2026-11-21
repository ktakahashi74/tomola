import { createHmac, timingSafeEqual } from "node:crypto";
import { authSecret } from "./auth/secret.server";
import type { SourceLang } from "./languages";

export type ReadingDisplay = { sourceLang: SourceLang; readLang: SourceLang; isTranslated: boolean };
type ReadingMark = ReadingDisplay & { topicId: number; exp: number };

const lifetime = 15 * 60_000;
const mac = (text: string) => createHmac("sha256", authSecret()).update(`topic-reading:${text}`).digest();

export function signReadingMark(topicId: number, display: ReadingDisplay, now = Date.now()): string {
  const payload: ReadingMark = { topicId, ...display, exp: now + lifetime };
  const text = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${text}.${mac(text).toString("base64url")}`;
}

export function readReadingMark(topicId: number, mark: string, now = Date.now()): ReadingDisplay | null {
  const [text, signature, extra] = mark.split(".");
  if (!text || !signature || extra !== undefined || mark.length > 512) return null;
  const supplied = Buffer.from(signature, "base64url");
  const expected = mac(text);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  // Only this server's signed payload is decoded.
  const payload: ReadingMark = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  return payload.topicId === topicId && payload.exp > now ? payload : null;
}
