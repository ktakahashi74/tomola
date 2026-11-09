import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { profiles } from "~/lib/db/schema";
import { safeLocalPath } from "~/lib/display-lang.server";
import { bindAuthToDatabase, getAuth, type Auth } from "./auth.server";
import { collectSessionCookies } from "./session-cookies.server";
import { reauthenticationPath } from "~/lib/reauth";

export const CREDENTIAL_FRESH_MS = 24 * 3600_000;
export function reauthenticationUrl(returnTo: string): string {
  return reauthenticationPath(safeLocalPath(returnTo));
}

// Whether a session was created (by a login) recently enough to add or confirm
// credentials. A missing or unparsable creation time is not fresh.
export function isCredentialSessionFresh(createdAt: unknown, now = Date.now()): boolean {
  const created = createdAt instanceof Date || typeof createdAt === "string" || typeof createdAt === "number" ? new Date(createdAt).getTime() : NaN;
  return Number.isFinite(created) && created >= now - CREDENTIAL_FRESH_MS;
}

// Credential creation and complete revocation share the profile mutex. Re-read
// the session inside it: a request authenticated before revocation may not mint
// a new credential after the revocation commits.
export async function withCredentialSession<T>(db: Db, userId: string, request: Request, returnTo: string, run: (tx: Db, auth: Auth) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    const [member] = await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!member) throw redirect("/onboarding");
    const auth = bindAuthToDatabase(await getAuth(), tx);
    const { response: current, headers } = await auth.api.getSession({ headers: request.headers, returnHeaders: true });
    collectSessionCookies(headers);
    if (!current || current.user.id !== userId || !isCredentialSessionFresh(current.session.createdAt)) throw redirect(reauthenticationUrl(returnTo));
    return run(tx, auth);
  });
}
