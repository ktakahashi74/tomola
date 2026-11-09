import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, profiles } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { setFollow } from "../app/lib/follows.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";
import { TOPICS_PER_PAGE, REPLIES_PER_PAGE } from "../app/lib/pagination";
import { EXCLUDED_COUNTRY } from "./operator-fixture";

export async function seedFirstLook(db: Db, dir: string) {
  const members = await db.select().from(profiles).where(inArray(profiles.handle, ["firstlook_author", "firstlook_stance", "firstlook_stance_unconsented", "firstlook_existing", "firstlook_existing_excluded", "firstlook_reader", "firstlook_writer", "firstlook_list_author", "firstlook_list_consent", "firstlook_paged_author", "firstlook_paged_consent"]));
  const uid = (handle: string) => members.find(p => p.handle === handle)!.userId;
  await db.update(profiles).set({ stanceConsentAt: null, stanceConsentVersion: null }).where(inArray(profiles.userId, [uid("firstlook_stance"), uid("firstlook_stance_unconsented"), uid("firstlook_list_consent"), uid("firstlook_paged_consent")]));
  for (const [handle, residenceCountry] of [["firstlook_existing", "JP"], ["firstlook_existing_excluded", EXCLUDED_COUNTRY]]) {
    await db.update(profiles).set({ trialConsentAt: null, trialConsentVersion: null, residenceCountry }).where(eq(profiles.userId, uid(handle)));
  }
  const now = new Date("2020-01-01T00:00:00Z");
  const question = await createTopic(db, uid("firstlook_author"), { title: "A choice after consent", body: "Choose after reviewing consent.", lang: "en", asksStance: true }, { now });
  const topic = await createTopic(db, uid("firstlook_writer"), { title: "New replies across pages", body: "A discussion with a long branch.", lang: "en" }, { now });
  if (!question.ok || !topic.ok) throw new Error("First look topics failed");
  const topicId = topic.id;
  await db.insert(entries).values(Array.from({ length: 100 }, (_, i) => ({ kind: "reply" as const, threadId: topic.id, authorId: uid("firstlook_writer"), lang: "en" as const, body: `Earlier reply ${i}`, createdAt: now, updatedAt: now })));
  let tick = now.getTime();
  async function reply(body: string, parentId?: number) {
    const made = await createReply(db, uid("firstlook_writer"), topicId, { body, lang: "en", parentId }, { now: new Date(tick += 1000) });
    if (!made.ok) throw new Error(made.error);
    return made.id;
  }
  const root = await reply("A branch on the second page.");
  let lastRead = root;
  for (let i = 0; i < 3; i++) lastRead = await reply(`Earlier branch reply ${i}.\n\n${"Context before the new replies. ".repeat(35)}`, root);
  await setFollow(db, uid("firstlook_reader"), topic.id, true, { now });
  const firstNew = await reply("The first new reply, inside the folded branch.", root);
  for (let i = 0; i < 8; i++) await reply(`A later new reply ${i}.\n\n${"More discussion. ".repeat(20)}`, root);
  const seeded = await db.select({ id: entries.id }).from(entries).where(eq(entries.threadId, topic.id));
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, [question.id, topic.id, ...seeded.map(e => e.id)]));
  // This member follows only this scenario's old questions, so page two is
  // independent of the global topic count and cannot displace other fixtures.
  const consentQuestions: number[] = [];
  for (let i = 0; i <= TOPICS_PER_PAGE; i++) {
    const stamp = new Date(Date.UTC(2019, 0, 1, 0, 0, i));
    const made = await createTopic(db, uid("firstlook_list_author"), { title: `Consent from a paged list ${i}`, body: "A question without replies.", lang: "en", asksStance: true }, { now: stamp });
    if (!made.ok) throw new Error(made.error);
    consentQuestions.push(made.id);
    await setFollow(db, uid("firstlook_list_consent"), made.id, true, { now: stamp });
  }
  const pagedQuestion = await createTopic(db, uid("firstlook_paged_author"), { title: "Consent from a reply page", body: "Return to the same reply page.", lang: "en", asksStance: true }, { now: new Date("2019-01-01T00:00:00Z") });
  if (!pagedQuestion.ok) throw new Error(pagedQuestion.error);
  const pagedReplies = await db.insert(entries).values(Array.from({ length: REPLIES_PER_PAGE + 1 }, (_, i) => ({ kind: "reply" as const, threadId: pagedQuestion.id, authorId: uid("firstlook_paged_author"), lang: "en" as const, body: `Reply page context ${i}`, createdAt: now, updatedAt: now }))).returning({ id: entries.id });
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, [...consentQuestions, pagedQuestion.id]));
  const invitations: Record<string, string> = {};
  for (const scenario of ["preserve", "retry", "leave", "excluded"]) {
    const invitation = await createInvitation(db, { email: `firstlook_${scenario}@example.com` });
    invitations[scenario] = inviteUrl(invitation.token);
  }
  fs.writeFileSync(path.join(dir, "first-look.json"), JSON.stringify({ questionId: question.id, topicId: topic.id, firstNew, lastRead, invitations, listQuestionId: consentQuestions[0], pagedQuestionId: pagedQuestion.id, pagedReplyId: Math.max(...pagedReplies.map(r => r.id)) }));
}
