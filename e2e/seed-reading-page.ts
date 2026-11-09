import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";

export async function seedReadingPage(db: Db) {
  const jaParagraph = "長い文章では、読む人が考えを追えるように、題と書き手から本文へ進む順序を整える。言葉が違っても、同じ節へ戻って読み直せる。";
  const enParagraph = "A long essay gives its reader room to examine each idea. The title and author introduce the text, while the contents help readers return to the section they need across languages. ";
  const extras = '\n\n> A short quotation.\n\n- First point\n- Second point\n\n```ts\nconst example = "a code block that should scroll within the body";\n```\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n| Term | Meaning |\n| --- | --- |\n| Reading | Time with a text |\n\nA note[^1].\n\n[^1]: A footnote.';
  const ja = Array.from({ length: 6 }, (_, i) => `${i % 2 ? "###" : "##"} 読むための節 ${i + 1}\n\n${jaParagraph.repeat(36)}`).join("\n\n") + extras;
  const en = Array.from({ length: 6 }, (_, i) => `${i % 2 ? "###" : "##"} Section for reading ${i + 1}\n\n${enParagraph.repeat(16)}`).join("\n\n") + extras;
  if (ja.length < 10_000 || en.length < 10_000) throw new Error("long reading fixtures must exceed 10,000 characters");
  const topic = await createTopic(db, "seed-kim", { lang: "ja", title: "長い文章を読む画面の確認", body: ja });
  const english = await createTopic(db, "seed-kim", { lang: "en", title: "Reading a long essay", body: en });
  const placeholder = await createTopic(db, "seed-kim", { lang: "en", title: "A withheld topic", body: "Withheld fixture body." });
  const noHeadings = await createTopic(db, "seed-kim", { lang: "en", title: "Reading without sections", body: enParagraph.repeat(3) });
  const longToc = await createTopic(db, "seed-kim", { lang: "en", title: "Reading many sections", body: enParagraph + "\n\n" + Array.from({ length: 40 }, (_, i) => `## Reading section ${i + 1}\n\n${enParagraph.repeat(4)}`).join("\n\n") });
  if (!topic.ok || !english.ok || !placeholder.ok || !noHeadings.ok || !longToc.ok) throw new Error("reading topic fixture failed");
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, placeholder.id));
  const reply = await createReply(db, "seed-kim", topic.id, { lang: "en", body: "A reply passage to quote.\n\nA second paragraph." });
  if (!reply.ok) throw new Error("reading reply fixture failed");
  const [source] = await db.select({ sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision }).from(entries).where(eq(entries.id, topic.id));
  await db.insert(translations).values([
    { entryId: topic.id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: en },
    { entryId: topic.id, field: "title", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: "Reading a translated essay" },
    { entryId: topic.id, field: "body", lang: "en", kind: "human", sourceHash: "earlier-fixture-source", mentionRevision: source.mentionRevision, flags: ["stale"], text: "## Earlier section\n\nA short earlier translation.\n\n## Another earlier section" },
  ]);
  await db.delete(jobs).where(inArray(jobs.kind, ["translate_entry", "translate_title", "embed_entry"]));
  const invitation = await createInvitation(db, { email: "reading_member@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "reading-page.json"), JSON.stringify({ topicId: topic.id, englishId: english.id, placeholderId: placeholder.id, noHeadingsId: noHeadings.id, longTocId: longToc.id, replyId: reply.id, invitation: inviteUrl(invitation.token) }));
}
