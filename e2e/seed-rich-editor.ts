import fs from "node:fs";
import path from "node:path";
import type { Db } from "../app/lib/db/client.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";

export const richEditorBody = "## Source heading\n\nA mention @a_b_c and a footnote[^note].\n\n| Item | Value |\n| --- | ---: |\n| alpha | 1 |\n| beta | 2 |\n\n[^note]: Original note with *emphasis*.\n\n";

export async function seedRichEditor(db: Db) {
  const invitations: Record<string, { email: string; invitation: string }> = {};
  for (const name of ["modes", "paste", "edit", "fallback", "early", "failure", "fix1_bold", "fix1_italic", "fix1_heading", "fix1_list", "fix1_layout", "images_button", "images_transfer", "images_cursor", "images_unfocused", "images_select", "images_paste", "images_edit", "images_error", "default", "memory", "math", "delayed", "composition", "unfocused", "mention_writer", "mention_under", "mention_hyphen", "screens"]) {
    const email = `rich_editor_${name}@example.com`;
    const invitation = await createInvitation(db, { email });
    invitations[name] = { email, invitation: inviteUrl(invitation.token) };
  }
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "rich-editor.json"), JSON.stringify({ invitations, body: richEditorBody }));
}
