import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAuth } from "../app/lib/auth/auth.server";
import { confirmUrl } from "../app/lib/auth/magic-link.server";
import type { Db } from "../app/lib/db/client.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";

export async function seedConfirmReasons(db: Db) {
  const invitation = await createInvitation(db, { email: "confirm_reasons@example.com" });
  const other = await createInvitation(db, { email: "confirm_reasons_other@example.com" });
  const email = "confirm_reasons_expired@example.com";
  await createInvitation(db, { email });
  let token = "";
  const baseURL = process.env.BETTER_AUTH_URL!;
  const auth = createAuth(db, { baseURL, secret: "confirm-reasons-test-only-secret-000000000000", sendMagicLink: async args => { token = args.token; } });
  await auth.api.signInMagicLink({ body: { email, metadata: { browserNonce: randomBytes(32).toString("base64url") } }, headers: new Headers() });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "confirm-reasons.json"), JSON.stringify({ invite: inviteUrl(invitation.token), otherInvite: inviteUrl(other.token), expiredLink: confirmUrl(baseURL, token) }));
}
