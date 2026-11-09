import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, user } from "../app/lib/db/schema";
import { createReply, createTopic, softDeleteEntry } from "../app/lib/entries.server";
import { createProfile } from "../app/lib/profiles.server";

export async function seedReplyBranches(db: Db) {
  const author = "reply-branches-fixture";
  await db.insert(user).values({ id: author, name: "", email: "twig_fixture@example.com", emailVerified: true });
  const profile = await createProfile(db, author, { handle: "twig_fixture", homeArea: "en", readLangs: ["en"] });
  if (!profile.ok) throw new Error(profile.error);
  const topic = async (title: string) => {
    const result = await createTopic(db, author, { lang: "en", title, body: "A conversation with interleaved replies.", asksStance: true });
    if (!result.ok) throw new Error(result.error);
    return result.id;
  };
  const reply = async (threadId: number, body: string, parentId?: number) => {
    const result = await createReply(db, author, threadId, { lang: "en", body, parentId, stanceTag: "agree" });
    if (!result.ok) throw new Error(result.error);
    return result.id;
  };
  const topicId = await topic("Reply branches fixture");
  const rootA = await reply(topicId, "Branch A root"), rootB = await reply(topicId, "Branch B root");
  const a: number[] = [], b: number[] = [];
  const chronological = [rootA, rootB];
  for (let i = 1; i <= 8; i++) {
    a.push(await reply(topicId, `Branch A reply ${i}`, i === 2 ? a[0] : rootA));
    chronological.push(a.at(-1)!);
    if (i <= 2) { b.push(await reply(topicId, `Branch B reply ${i}`, rootB)); chronological.push(b.at(-1)!); }
  }
  const hiddenRoot = await reply(topicId, "HIDDEN_BRANCH_BODY");
  const hiddenChild = await reply(topicId, "Child of hidden branch", hiddenRoot);
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hiddenRoot));
  const deletedRoot = await reply(topicId, "DELETED_BRANCH_BODY");
  const deletedChild = await reply(topicId, "Child of deleted branch", deletedRoot);
  await softDeleteEntry(db, deletedRoot);

  const continuationId = await topic("Reply branches continuation fixture");
  const previousRoot = await reply(continuationId, "Root on the previous page");
  const firstPageContinued: number[] = [];
  for (let i = 1; i <= 6; i++) firstPageContinued.push(await reply(continuationId, `First-page branch reply ${i}`, previousRoot));
  // Deleted rows still occupy their chronological positions, without unused placeholders.
  await db.insert(entries).values(Array.from({ length: 99 - firstPageContinued.length }, () => ({ kind: "reply" as const, threadId: continuationId, authorId: author, lang: "en" as const, body: "Deleted pagination position", deletedAt: new Date() })));
  const continued: number[] = [];
  for (let i = 1; i <= 7; i++) continued.push(await reply(continuationId, `Continuation reply ${i}`, i === 1 ? previousRoot : continued[i - 2]));
  const spareRoot = await reply(continuationId, "Another branch on page two");
  await db.delete(jobs).where(inArray(jobs.kind, ["translate_entry", "translate_title"]));
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "reply-branches.json"), JSON.stringify({ topicId, rootA, rootB, a, b, chronological, hiddenRoot, hiddenChild, deletedRoot, deletedChild, continuationId, previousRoot, firstPageContinued, continued, spareRoot }));
}
