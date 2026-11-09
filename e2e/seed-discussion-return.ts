import fs from "node:fs";
import path from "node:path";
import { inArray } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, user } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { createProfile } from "../app/lib/profiles.server";

export async function seedDiscussionReturn(db: Db) {
  const authorId = "discussion-return-fixture";
  await db.insert(user).values({ id: authorId, name: "", email: "discussion_fixture@example.com", emailVerified: true });
  const profile = await createProfile(db, authorId, { handle: "discussion_fixture", homeArea: "en", readLangs: ["en"] });
  if (!profile.ok) throw new Error("fixture profile failed");
  const topic = await createTopic(db, authorId, { lang: "en", title: "Discussion return pagination fixture", body: "A topic for returning to replies." });
  if (!topic.ok) throw new Error("fixture topic failed");
  const ids: number[] = [];
  for (let i = 1; i <= 102; i++) {
    const reply = await createReply(db, authorId, topic.id, { lang: "en", body: `Pagination reply ${i}`, ...(i === 102 ? { parentId: ids[0] } : {}) });
    if (!reply.ok) throw new Error("fixture reply failed");
    ids.push(reply.id);
  }
  await db.update(entries).set({ deletedAt: new Date() }).where(inArray(entries.id, ids.slice(1, 100)));
  await db.delete(jobs).where(inArray(jobs.kind, ["translate_entry", "translate_title"]));
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "discussion-return.json"), JSON.stringify({ topicId: topic.id, firstId: ids[0], lastId: ids.at(-1) }));
}
