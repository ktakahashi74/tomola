import { data } from "react-router";
import { getDb } from "~/lib/db/client.server";
import { decodeLoginCode, loginCodeLimited } from "./login-code.server";
import { pendingLoginCode } from "./login-code-cookie.server";
import { completeMagicLink, LOGIN_HEADERS } from "./complete-magic-link.server";
import { clientAddress } from "~/lib/http/client-ip.server";
// Call only after assertSameOrigin and the auth-page IP check.
export async function submitLoginCode(request: Request, form: FormData) {
  const pending = pendingLoginCode(request);
  const db = await getDb();
  const code = String(form.get("code") ?? "");
  const ip = clientAddress(request);
  const token = pending ? await decodeLoginCode(db, { ...pending, code: code.length <= 64 ? code : "", ip }) : null;
  if (token) { const response = await completeMagicLink(request, token); if (response) return response; }
  return data({ status: "code_invalid" as const, limited: pending ? await loginCodeLimited(db, pending.id, ip) : null }, { status: 400, headers: LOGIN_HEADERS });
}
