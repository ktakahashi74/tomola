import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { createInvitation } from "../app/lib/invitations.server";
import { createProfile } from "../app/lib/profiles.server";
import { createFakeEngine } from "../app/lib/llm/engines/fake.server";
import { inviteUrl } from "../app/lib/site-url";

export async function seedReadLang(db: Db) {
  const author = "seed-read-lang-author";
  await db.insert(user).values({ id: author, name: "", email: "read_lang_author@example.com", emailVerified: true });
  const profile = await createProfile(db, author, { handle: "read_lang_author", homeArea: "ja", readLangs: ["ja", "en"] });
  if (!profile.ok) throw new Error(profile.error);
  const engine = createFakeEngine();
  const topics = [];
  for (const lang of ["ja", "en", "fr"] as const) {
    const title = `Reading language ${lang} essay`;
    const body = `A reading-language fixture from ${lang}.\n\n## A section\n\nThe same essay remains in the list when its reading language changes.`;
    const topic = await createTopic(db, author, { lang, title, body });
    if (!topic.ok) throw new Error(topic.error);
    const [source] = await db.select({ sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision }).from(entries).where(eq(entries.id, topic.id));
    for (const to of ["ja", "en", "fr"] as const) if (to !== lang) {
      for (const field of ["title", "body"] as const) {
        const out = await engine.translate({ from: lang, to, text: field === "title" ? title : body });
        await db.insert(translations).values({ entryId: topic.id, field, lang: to, kind: "primary", engine: "fake", text: out.text, ...source });
      }
    }
    topics.push({ id: topic.id, lang, title, body });
  }
  // Leave these deterministic translations in place, without changing jobs for other fixtures.
  for (const topic of topics) await db.delete(jobs).where(sql`${jobs.payload}->>'entryId' = ${String(topic.id)}`);
  const invitations = [];
  for (const email of ["read_lang_member@example.com", "read_lang_nojs@example.com"]) {
    const invitation = await createInvitation(db, { email });
    invitations.push({ email, url: inviteUrl(invitation.token) });
  }
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "read-lang.json"), JSON.stringify({ topics, invitations }));
}
