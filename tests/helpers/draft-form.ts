import type { Db } from "~/lib/db/client.server";
import { getDraft } from "~/lib/drafts.server";

// Existing sequential route scenarios submit the version shown by the draft screen.
// Explicit versions take precedence so conflict scenarios can submit an older one.
export async function draftScreenForm(db: Db, ownerId: string, id: number, form: Record<string, string>) {
  const draft = await getDraft(db, ownerId, id);
  return draft?.kind === "topic" && draft.via === "web" && !draft.clientId ? { version: String(draft.version), ...form } : form;
}
