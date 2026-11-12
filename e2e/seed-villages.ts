import { chatSourceHash } from "../app/lib/village-chat-translations.server";
import { grantModerator } from "../app/lib/roles.server";
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { chatConsents, chatMessages, chatMessageTranslations, chatReads, chatSequences, notifications, entries, profiles, user, villageInvites, villageMembers, villages } from "../app/lib/db/schema";
import { villagesEnabled } from "../app/lib/villages-enabled.server";
import { createTopic, createReply } from "../app/lib/entries.server";
import { setVote } from "../app/lib/votes.server";
import { changeVillageMembership, setDefaultVillage } from "../app/lib/villages.server";
import { createDraft } from "../app/lib/drafts.server";
import { createSignupInvitation } from "../app/lib/signup-village.server";
import { createVillage, endVillage } from "../app/lib/village-management.server";
import { acceptChatConsent, mutateChat } from "../app/lib/village-chat.server";
import { villageChatEnabled } from "../app/lib/village-chat-enabled.server";

export async function seedVillages(db: Db, dir: string) {
  if (!villagesEnabled()) return;
  const joinMembers = await db.select({ id: profiles.userId, handle: profiles.handle }).from(profiles);
  const joinId = (handle: string) => joinMembers.find(member => member.handle === handle)!.id;
  for (const [slug, kind, owner] of [["join-state-open", "open", "zjoin_owner"], ["join-state-invite", "invite_public", "zjoin_owner"], ["join-state-ended", "invite_public", "zjoin_ended"], ["join-state-native", "open", "zjoin_native"]] as const) {
    const created = await createVillage(db, joinId(owner), { slug, name: slug, kind, description: "A public village for reading and participation." });
    if (!created.ok) throw new Error("Join state village creation failed");
  }
  const [joinInvite] = await db.select().from(villages).where(eq(villages.slug, "join-state-invite"));
  await db.insert(villageMembers).values({ villageId: joinInvite.id, userId: joinId("zjoin_invited") });
  if (!(await endVillage(db, joinId("zjoin_ended"), "join-state-ended")).ok) throw new Error("Join state village ending failed");
  // Destination-review fixtures model members who already chose their language village.
  const destinationMembers = await db.select({ id: profiles.userId, handle: profiles.handle }).from(profiles);
  for (const member of destinationMembers.filter(member => member.handle.startsWith("vtarget_") && member.handle !== "vtarget_join" || member.handle === "villages_member")) {
    await setDefaultVillage(db, member.id, "en");
  }
  const [personalAuthor] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "pv_author"));
  await changeVillageMembership(db, personalAuthor.id, "en", "join");
  for (const [title, target] of [["Personal browser post", "@pv_author"], ["Personal elsewhere post", "en"]]) {
    const result = await createTopic(db, personalAuthor.id, { title, body: "Owned personal village fixture.", lang: "en", village: target });
    if (!result.ok) throw new Error(result.error);
    await db.update(entries).set({ createdAt: sql`${entries.createdAt} - interval '730 days'`, lastActivityAt: sql`${entries.lastActivityAt} - interval '730 days'` }).where(eq(entries.id, result.id));
  }
  for (const suffix of ["a", "b", "long"]) {
    const [owner] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, `signup_entry_${suffix}`));
    const created = await createVillage(db, owner.id, { slug: `signup-entry-${suffix}`, name: `Signup entry ${suffix.toUpperCase()}`, kind: "invite_public", description: "" });
    if (!created.ok) throw new Error("Signup village fixture creation failed");
  }
  const [stoppedOwner] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "signup_stopped"));
  const stoppedVillage = await createVillage(db, stoppedOwner.id, { slug: "signup-stopped", name: "Stopped invitation village", kind: "invite_public", description: "" });
  if (!stoppedVillage.ok) throw new Error("Stopped signup village fixture creation failed");
  const [stoppedDestination] = await db.select({ id: villages.id }).from(villages).where(eq(villages.slug, "signup-stopped"));
  const stoppedInvitation = await createSignupInvitation(db, stoppedOwner.id, "signup_stopped_recipient@example.com", stoppedDestination.id);
  if (!stoppedInvitation) throw new Error("Stopped signup invitation fixture creation failed");
  fs.writeFileSync(path.join(dir, "signup-stopped-invitation.txt"), stoppedInvitation.token);
  await db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86400000) }).where(eq(profiles.userId, stoppedOwner.id));
  const [pageOwner] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "vpage_owner"));
  const pageVillage = await createVillage(db, pageOwner.id, { slug: "paged-village", name: "Paged village", description: "", kind: "invite_public" });
  if (!pageVillage.ok) throw new Error("Paged village creation failed");
  const [paged] = await db.select().from(villages).where(eq(villages.slug, "paged-village"));
  const pageMembers = Array.from({ length: 51 }, (_, n) => `vpage_member${String(n).padStart(2, "0")}`);
  await db.insert(user).values(pageMembers.map(id => ({ id, name: "", email: `${id}@example.com`, emailVerified: true })));
  await db.insert(profiles).values(pageMembers.map(id => ({ userId: id, handle: id, handleKey: id, homeArea: "other", readLangs: ["en"] })));
  await db.insert(villageMembers).values(pageMembers.map(userId => ({ villageId: paged.id, userId })));
  await db.insert(villageInvites).values(pageMembers.map(userId => ({ villageId: paged.id, userId, invitedBy: pageOwner.id, kind: "owner" })));
  for (let n = 0; n < 31; n++) {
    const topic = await createTopic(db, pageOwner.id, { title: `Paged village topic ${n}`, body: "Owned pagination body.", lang: "en", village: paged.slug });
    if (!topic.ok) throw new Error(topic.error);
  }
  // Keep these pagination topics behind the other public fixtures on the newest-first home page.
  await db.update(entries).set({ createdAt: sql`${entries.createdAt} - interval '730 days'`, lastActivityAt: sql`${entries.lastActivityAt} - interval '730 days'` }).where(eq(entries.villageId, paged.id));
  // The villages of the follow scenarios: one that is followed and one that is not, each with a post, written by a member who is not a reader of the scenarios.
  const [followOwner] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "vfollow_owner"));
  for (const [slug, name, title] of [["follow-fixture", "Follow fixture village", "Follow fixture topic"], ["follow-other", "Follow other village", "Follow other topic"]] as const) {
    const created = await createVillage(db, followOwner.id, { slug, name, description: "", kind: "open" });
    if (!created.ok) throw new Error("Follow fixture village creation failed");
    const topic = await createTopic(db, followOwner.id, { title, body: `A post in ${name}.`, lang: "en", village: slug });
    if (!topic.ok) throw new Error(topic.error);
  }
  const [serializedWriter] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "vtarget_serialized"));
  await changeVillageMembership(db, serializedWriter.id, "ja", "join");
  const [reviewOwner] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "vr_owner"));
  for (const input of [
    { slug: "village-review-journey", name: "A village for independent review", description: "Original public description." },
    { slug: "village-direct-review", name: "Original direct village", description: "Original direct description" },
  ]) {
    const created = await createVillage(db, reviewOwner.id, { ...input, kind: "open" });
    if (!created.ok) throw new Error("Village review fixture creation failed");
  }
  const [ownAuthor] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "co_author"));
  const [ownReader] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "co_reader"));
  for (const slug of ["own-chat-browser", "linked-chat-browser"]) {
    const created = await createVillage(db, ownReader.id, { slug, name: slug, description: "", kind: "open" });
    if (!created.ok || !await changeVillageMembership(db, ownAuthor.id, slug, "join")) throw new Error("Own chat fixture creation failed");
  }
  const linkedTopicIds: number[] = [];
  for (let i = 0; i < 4; i++) {
    const title = i === 0 ? "A public topic linked from chat" : `A public topic linked from chat ${i + 1}`;
    const topic = await createTopic(db, ownAuthor.id, { title, body: "A public body for a linked discussion", lang: "en" });
    if (!topic.ok) throw new Error("Linked chat topic fixture creation failed");
    linkedTopicIds.push(topic.id);
  }
  fs.writeFileSync(path.join(dir, "chat-own.json"), JSON.stringify({ linkedTopicIds }));
  const [author] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "villages_member"));
  const [voter] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "villages_other"));
  const topics = [];
  for (let index = 0; index < 3; index++) {
    const title = `Village placement fixture ${index}`;
    const result = await createTopic(db, author.id, { title, body: `A village fixture ${index}.`, lang: index === 1 ? "ja" : "en" }, { now: new Date(Date.UTC(2025, 3, 1, 0, index)) });
    if (!result.ok) throw new Error(result.error);
    topics.push({ id: result.id, title });
  }
  const reply = await createReply(db, voter.id, topics[0].id, { body: "Reply from outside the village.", lang: "en" }, { now: new Date(Date.UTC(2025, 3, 2)) });
  if (!reply.ok) throw new Error(reply.error);
  await setVote(db, voter.id, topics[1].id, true);
  const hiddenPlace = { slug: "hidden-metadata-village", name: "Hidden metadata village", kind: "open", description: "" };
  if (!(await createVillage(db, author.id, hiddenPlace)).ok) throw new Error("Hidden metadata village creation failed");
  const hidden = await createTopic(db, author.id, { title: "Hidden village fixture", body: "Hidden village content.", lang: "en", village: hiddenPlace.slug });
  if (!hidden.ok) throw new Error(hidden.error);
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hidden.id));
  await db.update(profiles).set({ suspendedUntil: new Date("2100-01-01"), suspendedReason: "other" }).where(eq(profiles.handle, "villages_suspended"));
  fs.writeFileSync(path.join(dir, "villages.json"), JSON.stringify({ topics, hiddenId: hidden.id, hiddenPlace }));
  const [layoutChat] = await db.insert(villages).values({ slug: "chat-layout", name: "Chat layout", kind: "open" }).returning();
  const layoutMembers = await db.select({ id: profiles.userId, handle: profiles.handle }).from(profiles);
  const layoutIds = new Map(layoutMembers.map(row => [row.handle, row.id]));
  await db.insert(villageMembers).values(["ui_chat_author", "ui_chat_reader"].map(handle => ({ villageId: layoutChat.id, userId: layoutIds.get(handle)! })));
  await db.insert(chatMessages).values(Array.from({ length: 12 }, (_, i) => ({ villageId: layoutChat.id, authorId: layoutIds.get(i === 11 ? "ui_chat_reader" : "ui_chat_author")!, body: i === 11 ? "Own layout message" : `Layout message ${i + 1}: a conversation that remains readable while the composer stays in view.`, lang: "en", createdSeq: i + 1, changedSeq: i + 1 })));
  await db.insert(chatSequences).values({ villageId: layoutChat.id, seq: 12 });
  for (const [slug, handle, count] of [["chat-footer", "ui_chat_footer", 12], ["chat-draft", "ui_chat_draft", 1]] as const) {
    const [village] = await db.insert(villages).values({ slug, name: slug, kind: "open" }).returning();
    await db.insert(villageMembers).values({ villageId: village.id, userId: layoutIds.get(handle)! });
    await db.insert(chatMessages).values(Array.from({ length: count }, (_, i) => ({ villageId: village.id, authorId: layoutIds.get(handle)!, body: `An independent chat message ${i + 1}`, lang: "en", createdSeq: i + 1, changedSeq: i + 1 })));
    await db.insert(chatSequences).values({ villageId: village.id, seq: count });
  }
  for (const [slug, handles] of [
    ["chat-live", ["vchat_live_a", "vchat_live_b"]],
    ["chat-access", ["vchat_access_a", "vchat_access_b"]],
    ["chat-nojs", ["vchat_nojs_a", "vchat_nojs_b"]],
    ["chat-ime", ["vchat_ime_a"]],
    ["chat-fallback", ["vchat_fallback_a", "vchat_fallback_b"]],
    ["chat-history", ["vchat_history_a", "vchat_history_b"]],
    ["chat-mentions", ["vcm_author", "vcm_reader"]],
  ] as const) {
    const [village] = await db.insert(villages).values({ slug, name: slug, kind: "open" }).returning();
    for (const handle of handles) {
      const [member] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, handle));
      await db.insert(villageMembers).values({ villageId: village.id, userId: member.id });
    }
  }
  const [caseVillage] = await db.insert(villages).values({ slug: "chat-report-flow", name: "Report workflow village", kind: "invite_public" }).returning();
  const caseMembers = await db.select({ id: profiles.userId, handle: profiles.handle }).from(profiles);
  const byHandle = new Map(caseMembers.map(row => [row.handle, row.id]));
  for (const handle of ["crflow_writer", "crflow_reporter"]) await db.insert(villageMembers).values({ villageId: caseVillage.id, userId: byHandle.get(handle)!, role: handle === "crflow_reporter" ? "owner" : "member" });
  for (const handle of ["crflow_mod", "crflow_review"]) await grantModerator(db, byHandle.get("crflow_op")!, byHandle.get(handle)!, "en");
  const bodies = ["Context before the reported message", "Private chat review fixture body", "Context after the reported message"];
  const caseMessages = await db.insert(chatMessages).values(bodies.map((body, i) => ({ villageId: caseVillage.id, authorId: byHandle.get("crflow_writer")!, body, lang: "en", createdSeq: i + 1, changedSeq: i + 1 }))).returning({ id: chatMessages.id });
  await db.insert(chatSequences).values({ villageId: caseVillage.id, seq: bodies.length });
  fs.writeFileSync(path.join(dir, "chat-report.json"), JSON.stringify({ id: caseMessages[1].id, body: bodies[1], villageName: caseVillage.name }));
  const [history] = await db.select().from(villages).where(eq(villages.slug, "chat-history"));
  const [historyAuthor] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "vchat_history_a"));
  const historyMessages = await db.insert(chatMessages).values(Array.from({ length: 125 }, (_, i) => ({ villageId: history.id, authorId: historyAuthor.id, lang: "en", body: `History message ${i + 1}`, createdSeq: i + 1, changedSeq: i + 1 }))).returning({ id: chatMessages.id });
  await db.insert(chatSequences).values({ villageId: history.id, seq: 125 });
  fs.writeFileSync(path.join(dir, "chat-history.json"), JSON.stringify({ at: historyMessages[54].id }));
  const [mentionVillage] = await db.select().from(villages).where(eq(villages.slug, "chat-mentions"));
  const [mentionAuthor] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "vcm_author"));
  await db.insert(chatMessages).values(Array.from({ length: 60 }, (_, i) => ({ villageId: mentionVillage.id, authorId: mentionAuthor.id, lang: "en", body: `Mention history ${i + 1}`, createdSeq: i + 1, changedSeq: i + 1 })));
  await db.insert(chatSequences).values({ villageId: mentionVillage.id, seq: 60 });
  const calendarNoon = Date.parse(new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10) + "T03:00:00Z");
  for (const scenario of ["tools", "window", "poll", "trim", "live", "recovery"]) {
    const [village] = await db.insert(villages).values({ slug: `chat-front-${scenario}`, name: `Chat front ${scenario}`, kind: "open" }).returning();
    await db.insert(villageMembers).values(["writer", "reader"].map(role => ({ villageId: village.id, userId: byHandle.get(`front_chat_${scenario}_${role}`)! })));
    const count = ["window", "trim"].includes(scenario) ? 420 : scenario === "live" ? 300 : scenario === "recovery" ? 60 : 3;
    await db.insert(chatMessages).values(Array.from({ length: count }, (_, i) => ({ villageId: village.id, authorId: byHandle.get(`front_chat_${scenario}_writer`)!, body: `Front ${scenario} message ${i + 1}`, lang: "en", createdSeq: i + 1, changedSeq: i + 1, createdAt: new Date(Date.UTC(2026, 0, 15, 0, i)) })));
    await db.insert(chatSequences).values({ villageId: village.id, seq: count });
    await db.insert(chatReads).values({ villageId: village.id, userId: byHandle.get(`front_chat_${scenario}_reader`)!, seq: scenario === "trim" ? 0 : count });
  }
  fs.writeFileSync(path.join(dir, "chat-calendar.json"), JSON.stringify({ now: calendarNoon }));
  for (const scenario of ["scroll", "tools", "report"]) {
    const [village] = await db.insert(villages).values({ slug: `chat-flow-${scenario}`, name: `Chat flow ${scenario}`, kind: "open" }).returning();
    await db.insert(villageMembers).values(["writer", "reader"].map(role => ({ villageId: village.id, userId: byHandle.get(`chat_flow_${scenario}_${role}`)! })));
    const count = scenario === "scroll" ? 120 : 3;
    const messages = await db.insert(chatMessages).values(Array.from({ length: count }, (_, i) => ({ villageId: village.id,
      authorId: byHandle.get(`chat_flow_${scenario}_${scenario === "tools" && i === 2 ? "reader" : "writer"}`)!,
      body: scenario === "tools" && i < 2 ? `原文の発言 ${i + 1}` : `Flow ${scenario} message ${i + 1}`, lang: scenario === "tools" && i < 2 ? "ja" : "en",
      createdAt: new Date(calendarNoon - (scenario === "tools" ? (i === 0 ? 2 : 1) * 86400000 : 86400000) + i * 60000), createdSeq: i + 1, changedSeq: i + 1,
    }))).returning();
    await db.insert(chatSequences).values({ villageId: village.id, seq: count });
    if (scenario === "scroll") await db.insert(chatReads).values({ villageId: village.id, userId: byHandle.get("chat_flow_scroll_reader")!, seq: 90 });
    if (scenario === "tools") await db.insert(chatMessageTranslations).values(messages.slice(0, 2).map((message, i) => ({ messageId: message.id, lang: "en", sourceHash: chatSourceHash(message.body), state: "ready" as const, text: `Translated message ${i + 1}` })));
  }
  for (const scenario of ["continuation", "state", "native", "calendar", "hover", "sendread", "failed", "readlive", "resync", "ownprefix"]) {
    const [village] = await db.insert(villages).values({ slug: `chat-next-${scenario}`, name: `Chat next ${scenario}`, kind: "open" }).returning();
    await db.insert(villageMembers).values(["writer", "reader"].map(role => ({ villageId: village.id, userId: byHandle.get(`chat_next_${scenario}_${role}`)! })));
    const count = ["calendar", "hover", "readlive"].includes(scenario) ? 4 : scenario === "resync" ? 60 : scenario === "ownprefix" ? 61 : scenario === "sendread" ? 220 : 120;
    const messages = await db.insert(chatMessages).values(Array.from({ length: count }, (_, i) => ({ villageId: village.id,
      authorId: byHandle.get(`chat_next_${scenario}_${scenario === "hover" && i === 1 || scenario === "ownprefix" && i === 10 ? "reader" : "writer"}`)!,
      // One message of the "state" chat is written in Japanese and shown by its English translation (the one the original-reading switch acts on).
      body: scenario === "state" && i === 40 ? "原文の発言 state" : `Next ${scenario} message ${i + 1}${scenario === "sendread" && i === 59 ? " @chat_next_sendread_reader" : ""}`, lang: scenario === "state" && i === 40 ? "ja" : "en",
      createdAt: new Date(Date.parse("2026-01-15T23:30:00Z") + i * 60000), createdSeq: i + 1, changedSeq: i + 1,
    }))).returning();
    await db.insert(chatSequences).values({ villageId: village.id, seq: count });
    await db.insert(chatReads).values({ villageId: village.id, userId: byHandle.get(`chat_next_${scenario}_reader`)!, seq: ["continuation", "native", "sendread", "failed", "ownprefix"].includes(scenario) ? 10 : scenario === "state" ? 40 : scenario === "resync" ? 20 : count });
    if (scenario === "sendread") await db.insert(notifications).values({ kind: "chat_mention", userId: byHandle.get("chat_next_sendread_reader")!, actorId: byHandle.get("chat_next_sendread_writer")!, villageId: village.id, chatMessageId: messages[59].id });
    if (scenario === "state") await db.insert(chatMessageTranslations).values([
      ...messages.filter(message => message.lang === "en").map(message => ({ messageId: message.id, lang: "ja", sourceHash: chatSourceHash(message.body), state: "ready" as const, text: `訳 ${message.createdSeq}` })),
      ...messages.filter(message => message.lang === "ja").map(message => ({ messageId: message.id, lang: "en", sourceHash: chatSourceHash(message.body), state: "ready" as const, text: "Translated state message" })),
    ]);
  }
  const [lounge] = await db.insert(villages).values({ slug: "chat-flow-lounge", name: "Chat flow lounge", kind: "open" }).returning();
  await db.insert(villageMembers).values({ villageId: lounge.id, userId: byHandle.get("chat_flow_scroll_reader")! });
  // Navigation and notification scenarios (ux-nav): a chat with a message that names the reader and one with news only, and three replies to one post by two people.
  const [uxChat] = await db.insert(villages).values({ slug: "ux-nav-chat", name: "UX nav chat", kind: "open" }).returning();
  const [uxNews] = await db.insert(villages).values({ slug: "ux-nav-news", name: "UX nav news", kind: "open" }).returning();
  const [uxSend] = await db.insert(villages).values({ slug: "ux-nav-send", name: "UX nav send", kind: "open" }).returning();
  await db.insert(villageMembers).values(["uxnav_send", "uxnav_author"].map(handle => ({ villageId: uxSend.id, userId: byHandle.get(handle)! })));
  for (const village of [uxChat, uxNews]) await db.insert(villageMembers).values(["uxnav_reader", "uxnav_author", "uxnav_count"].map(handle => ({ villageId: village.id, userId: byHandle.get(handle)! })));
  const uxTopic = await createTopic(db, byHandle.get("uxnav_notice")!, { title: "UX nav grouped replies", body: "A post that several people answer.", lang: "en" });
  if (!uxTopic.ok) throw new Error(uxTopic.error);
  for (const [who, body] of [["uxnav_author", "First reply to the grouped post."], ["uxnav_quiet", "Second reply from another member."], ["uxnav_author", "Third reply, the newest, is the excerpt."]] as const) {
    const posted = await createReply(db, byHandle.get(who)!, uxTopic.id, { body, lang: "en" });
    if (!posted.ok) throw new Error(posted.error);
  }
  fs.writeFileSync(path.join(dir, "ux-nav.json"), JSON.stringify({ topic: uxTopic.id, messages: [] }));
  if (villageChatEnabled()) {
    const existing = await db.select({ slug: villages.slug, userId: villageMembers.userId }).from(villageMembers)
      .innerJoin(villages, eq(villages.id, villageMembers.villageId));
    for (const row of existing) await acceptChatConsent(db, row.userId, row.slug!);
    // Sent through the chat itself, so that the mention is resolved and told.
    const navAuthor = byHandle.get("uxnav_author")!;
    const navIds: string[] = [];
    for (const body of ["Hello @uxnav_reader, this one is for you.", "A second message for everybody.", "A third message, a bit longer so that it can wrap on a narrow screen: the actions must stay clear of this text.", "Hello @uxnav_count, a message for you."]) navIds.push((await mutateChat(db, navAuthor, "ux-nav-chat", "send", { body })).id);
    await mutateChat(db, navAuthor, "ux-nav-news", "send", { body: "News without a mention." });
    fs.writeFileSync(path.join(dir, "ux-nav.json"), JSON.stringify({ topic: uxTopic.id, messages: navIds }));
    for (const [slug, handles] of [
      ["chat-consent", ["ccn_owner", "ccn_member"]],
      ["chat-consent-nojs", ["ccn_nojs"]],
      ["chat-consent-v2", ["ccn_v2"]],
    ] as const) {
      const [village] = await db.insert(villages).values({ slug, name: slug, kind: "open" }).returning();
      await db.insert(villageMembers).values(handles.map((handle, i) => ({ villageId: village.id, userId: byHandle.get(handle)!, role: i === 0 ? "owner" : "member" })));
      if (slug === "chat-consent") await db.insert(chatConsents).values({ villageId: village.id, userId: byHandle.get("ccn_owner")!, version: 1, consentedAt: new Date("2026-01-01T00:00:00Z") });
      if (slug === "chat-consent-v2") await db.insert(chatConsents).values({ villageId: village.id, userId: byHandle.get("ccn_v2")!, version: 2, consentedAt: new Date("2026-01-01T00:00:00Z") });
      await db.insert(chatMessages).values({ villageId: village.id, authorId: byHandle.get(handles[0])!, lang: "en", body: "Consent-protected history", createdSeq: 1, changedSeq: 1 });
      await db.insert(chatSequences).values({ villageId: village.id, seq: 1 });
    }
    const [translationVillage] = await db.insert(villages).values({ slug: "chat-translation-live", kind: "open", name: "Translation chat" }).returning();
    await db.insert(villageMembers).values(["ctxlive_writer", "ctxlive_reader", "ctxlive_noagree"].map(userId => ({ villageId: translationVillage.id, userId: byHandle.get(userId)! })));
    const history = await db.insert(chatMessages).values(Array.from({ length: 55 }, (_, i) => ({ villageId: translationVillage.id, authorId: byHandle.get("ctxlive_writer")!, lang: i ? "en" : "ja", body: i ? `Translation history ${i + 1}` : "昔の見えていない発言。", createdSeq: i + 1, changedSeq: i + 1 }))).returning({ id: chatMessages.id });
    await db.insert(chatSequences).values({ villageId: translationVillage.id, seq: 55 });
    fs.writeFileSync(path.join(dir, "chat-translation.json"), JSON.stringify({ oldId: history[0].id }));
  }
  // Destination scenarios are part of this enabled-only fixture. Private seeds stay unchanged.
  for (const name of ["switch", "rich", "settings", "draft", "frontmatter", "screens", "conflict", "stale", "recheck", "recheck_nojs", "signed_review"]) {
    const [member] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, `vtarget_${name}`));
    await changeVillageMembership(db, member.id, "ja", "join");
    if (name === "signed_review") await db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, member.id));
    if (name === "draft") {
      const draft = await createDraft(db, member.id, { kind: "topic", title: "Destination approval fixture", body: "An owned draft destination.", lang: "en", village: "en" }, { via: "api", client: { key: "fixture:vtarget", id: "fixture:vtarget", name: "Destination fixture", uri: null } });
      if (!draft.ok) throw new Error(draft.error);
      fs.writeFileSync(path.join(dir, "village-target.json"), JSON.stringify({ draftId: draft.id }));
    }
  }
}
