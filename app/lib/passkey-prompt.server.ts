import { createHash } from "node:crypto";
import { PASSKEY_PROMPT_MAX_AGE } from "./passkey-prompt";

export function passkeyPromptPreference(request: Request, userId: string, now = Date.now()) {
  const secure = new URL(request.url).protocol === "https:";
  const cookieName = `${secure ? "__Host-" : ""}tomola.passkey-later-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;
  const values = (request.headers.get("cookie") ?? "").split(";").map(c => c.trim()).filter(c => c.startsWith(`${cookieName}=`));
  const until = values.length === 1 ? Number(values[0].slice(cookieName.length + 1)) : NaN;
  return { cookieName, deferred: Number.isFinite(until) && until > now && until <= now + PASSKEY_PROMPT_MAX_AGE * 1000 };
}
