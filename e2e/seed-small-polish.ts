import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";

export async function seedSmallPolish(db: Db) {
  const paragraph = "Selecting a passage should keep the reply action close to the words being read. A longer paragraph makes the selection span several lines on both a phone and a desktop. ".repeat(4);
  const body = `## Passage\n\n${paragraph}\n\n> A quoted passage.\n\n## Another passage\n\n${paragraph}\n\n## Ending passage\n\n${paragraph}`;
  const topic = await createTopic(db, "seed-kim", { lang: "ja", title: "表示を切り替える話題", body });
  if (!topic.ok) throw new Error("polish topic fixture failed");
  const reply = await createReply(db, "seed-kim", topic.id, { lang: "en", body: paragraph });
  if (!reply.ok) throw new Error("polish reply fixture failed");
  const [source] = await db.select().from(entries).where(eq(entries.id, topic.id));
  await db.insert(translations).values([
    { entryId: topic.id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: body },
    { entryId: topic.id, field: "title", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: "A translated passage" },
    { entryId: topic.id, field: "body", lang: "en", kind: "human", sourceHash: "earlier-polish-source", mentionRevision: source.mentionRevision, flags: ["stale"], text: body },
  ]);
  await db.delete(jobs).where(inArray(jobs.kind, ["translate_entry", "translate_title", "embed_entry"]));
  const invitation = await createInvitation(db, { email: "polish_reader@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "small-polish.json"), JSON.stringify({ topicId: topic.id, replyId: reply.id, invitation: inviteUrl(invitation.token) }));
}
