import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, entryRevisions, jobs, moderationActions, roles, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { PURGED_QUESTION_TITLE } from "../app/lib/retention";

export async function seedRetention(db: Db, directory: string) {
  const member = async (email: string) => {
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (!row) throw new Error("Missing retention member fixture");
    return row.id;
  };
  const author = await member("retention_author@example.com"), actor = await member("retention_actor@example.com"), reviewer = await member("retention_reviewer@example.com");
  const topic = await createTopic(db, author, { title: "Retention appeal fixture", body: "The former question body.", lang: "en", asksStance: true });
  if (!topic.ok) throw new Error("Could not create retention question fixture");
  const old = new Date(Date.now() - 60 * 86_400_000);
  const [revision] = await db.insert(entryRevisions).values({ entryId: topic.id, title: null, body: "", editorId: author, editedAt: old }).returning();
  const [action] = await db.insert(moderationActions).values({ action: "fix_entry", targetEntryId: topic.id, actorId: actor, reason: "other", revisionId: revision.id, createdAt: old }).returning();
  await db.update(entries).set({ title: PURGED_QUESTION_TITLE, body: "", sourceHash: null, html: null, cardHtml: null, deletedAt: old, createdAt: old, lastActivityAt: old }).where(eq(entries.id, topic.id));
  await db.delete(jobs).where(sql`${jobs.payload}->>'entryId' = ${String(topic.id)}`);
  await db.insert(roles).values({ userId: reviewer, role: "moderator", lang: "en" });
  fs.writeFileSync(path.join(directory, "retention.json"), JSON.stringify({ actionId: action.id }));
}
