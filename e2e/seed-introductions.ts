import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, profiles, translations } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";
import { seedMembers } from "./seed-members";

export async function seedIntroductions(db: Db, dir: string, baseURL: string) {
  const handle = "intro_list_other";
  await seedMembers(db, dir, baseURL, [{ handle, email: `${handle}@example.com`, homeArea: "ja", uiLocale: "en" }]);
  const [member] = await db.select().from(profiles).where(eq(profiles.handle, handle));
  const made = await createTopic(db, member.userId, { lang: "ja", title: "読書と散歩の自己紹介", body: "読書や散歩について話したいです。" }, { asIntroduction: true, now: new Date("2020-01-01T00:00:00Z") });
  if (!made.ok) throw new Error(made.error);
  const [entry] = await db.select().from(entries).where(eq(entries.id, made.id));
  await db.insert(translations).values([
    { entryId: entry.id, field: "title", lang: "en", kind: "primary", text: "Books and walks", sourceHash: entry.sourceHash, mentionRevision: entry.mentionRevision, engine: "fake", model: "fake-1" },
    { entryId: entry.id, field: "body", lang: "en", kind: "primary", text: "I would like to discuss books and walks.", sourceHash: entry.sourceHash, mentionRevision: entry.mentionRevision, engine: "fake", model: "fake-1" },
  ]);
  await db.delete(jobs).where(eq(sql<number>`(${jobs.payload}->>'entryId')::bigint`, entry.id));
  const invitation = await createInvitation(db, { email: "intro_list_writer@example.com" });
  fs.writeFileSync(path.join(dir, "introductions.json"), JSON.stringify({ invite: inviteUrl(invitation.token), otherId: made.id, otherHandle: handle }));
}
