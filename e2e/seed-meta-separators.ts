import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user, villageMembers, villages } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { setVote } from "../app/lib/votes.server";
import { villagesEnabled } from "../app/lib/villages-enabled.server";

export async function seedMetaSeparators(db: Db, dir: string) {
  if (!villagesEnabled()) return;
  const member = async (role: string) => (await db.select({ id: user.id }).from(user).where(eq(user.email, `listmeta_${role}@example.com`)))[0].id;
  const writer = await member("writer"), reader = await member("reader");
  const [village] = await db.insert(villages).values({ slug: "meta-separators", name: "Metadata examples", kind: "open" }).returning();
  await db.insert(villageMembers).values([writer, reader].map(userId => ({ villageId: village.id, userId })));
  // Old activity keeps these fixtures from displacing other scenarios' home rows.
  const now = new Date("2014-01-01T12:00:00Z");
  const rich = await createTopic(db, writer, { lang: "ja", title: "属性の区切りの見本", body: "項目を区切る表示の確認。", village: village.slug }, { now });
  const plain = await createTopic(db, writer, { lang: "en", title: "A plain metadata example", body: "A row without optional metadata." }, { now });
  if (!rich.ok || !plain.ok) throw new Error("metadata topics failed");
  const reply = await createReply(db, reader, rich.id, { lang: "en", body: "An example reply." }, { now });
  if (!reply.ok) throw new Error("metadata reply failed");
  const [source] = await db.select().from(entries).where(eq(entries.id, rich.id));
  await db.insert(translations).values(["title", "body"].map(field => ({
    entryId: rich.id, field, lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash,
    mentionRevision: source.mentionRevision, text: field === "title" ? "A translated metadata example" : "A translated passage.",
  })));
  await setVote(db, reader, rich.id, true);
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, [rich.id, plain.id, reply.id]));
  fs.writeFileSync(path.join(dir, "meta-separators.json"), JSON.stringify({ rich: rich.id, plain: plain.id }));
}
