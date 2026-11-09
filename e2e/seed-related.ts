import fs from "node:fs";
import path from "node:path";
import type { Db } from "../app/lib/db/client.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";

// Only invitations here. The browser suite creates its own discussions so
// other suites' initial topic lists and pagination remain independent.
export async function seedRelatedInvitations(db: Db) {
  const writer = await createInvitation(db, { email: "related_browser_writer@example.com" });
  const reader = await createInvitation(db, { email: "related_browser_reader@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "related-invites.json"), JSON.stringify({ writer: inviteUrl(writer.token), reader: inviteUrl(reader.token) }));
}
