import fs from "node:fs";
import path from "node:path";
import type { Db } from "../app/lib/db/client.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";

export async function seedConfirmReasons(db: Db) {
  const invitation = await createInvitation(db, { email: "confirm_reasons@example.com" });
  const other = await createInvitation(db, { email: "confirm_reasons_other@example.com" });
  const expiry = await createInvitation(db, { email: "confirm_reasons_expired@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "confirm-reasons.json"), JSON.stringify({ invite: inviteUrl(invitation.token), otherInvite: inviteUrl(other.token), expiryInvite: inviteUrl(expiry.token) }));
}
