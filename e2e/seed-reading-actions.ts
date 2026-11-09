import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, user } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";

export async function seedReadingActions(db: Db, dir: string) {
  const [member] = await db.select({ id: user.id }).from(user).where(eq(user.email, "reading_actions@example.com"));
  const paragraph = "Reading an article takes time. Its actions stay within reach while the reader considers the argument and returns to an earlier passage. ";
  const at = new Date("2025-01-01T00:00:00Z");
  const fixture: Record<string, number> = {};
  for (const [key, body] of [
    ["toc", Array.from({ length: 6 }, (_, i) => `## Reading section ${i + 1}\n\n${paragraph.repeat(20)}`).join("\n\n")],
    ["plain", Array.from({ length: 16 }, () => paragraph.repeat(6)).join("\n\n")],
    ["hidden", paragraph],
  ]) {
    const topic = await createTopic(db, member.id, { lang: "en", title: `Article actions ${key}`, body }, { now: at });
    if (!topic.ok) throw new Error(topic.error);
    fixture[key] = topic.id;
  }
  const reply = await createReply(db, member.id, fixture.toc, { lang: "en", body: "A reply before the public reading invitation." }, { now: at });
  if (!reply.ok) throw new Error(reply.error);
  fixture.reply = reply.id;
  await db.update(entries).set({ hiddenAt: at }).where(eq(entries.id, fixture.hidden));
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, Object.values(fixture)));
  fs.writeFileSync(path.join(dir, "reading-actions.json"), JSON.stringify(fixture));
}
