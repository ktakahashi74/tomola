import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatConsents, chatMentions, notifications, profiles, villageMembers } from "./db/schema";
import { CHAT_CONSENT_VERSION } from "./village-chat-consent";
import { chatParts, type ChatMentionTarget } from "./village-chat";
import { handleKey } from "./handles";
import { mentionCandidates, tokenPrefixes } from "./mention-syntax";
import { enqueueImmediateEmails } from "./notifications.server";
import { MENTION_NOTIFY_LIMIT } from "./mention-notifications";

type Token = { spelling: string; prefix: string };
type Target = { userId: string; publicId: string; tokens: Token[] };

// Parse only plain-text parts, never URL destinations or Markdown. Membership locks precede the sequence allocator.
export async function resolveChatMentions(tx: Db, villageId: string, body: string): Promise<Target[]> {
  const candidates = chatParts(body).flatMap(part => part.type === "text" ? mentionCandidates(part.text).map(candidate => ({ ...candidate, spelling: part.text.slice(candidate.start, candidate.end) })) : []);
  const keys = [...new Set(candidates.flatMap(candidate => tokenPrefixes(candidate.token).map(handleKey)))];
  if (!keys.length) return [];
  // Resolve the global namespace first: an outside member's longer name must never fall back to a village member.
  const rows = await tx.select({ key: profiles.handleKey, userId: profiles.userId, publicId: profiles.publicId }).from(profiles).where(inArray(profiles.handleKey, keys));
  const byKey = new Map(rows.map(row => [row.key, row]));
  const resolved = candidates.flatMap(candidate => {
    const prefix = tokenPrefixes(candidate.token).find(prefix => byKey.has(handleKey(prefix)));
    return prefix ? [{ candidate, prefix, row: byKey.get(handleKey(prefix))! }] : [];
  });
  if (!resolved.length) return [];
  const members = await tx.select({ userId: villageMembers.userId }).from(villageMembers)
    .where(and(eq(villageMembers.villageId, villageId), inArray(villageMembers.userId, [...new Set(resolved.map(target => target.row.userId))])))
    .orderBy(asc(villageMembers.userId)).for("share");
  const joined = new Set(members.map(member => member.userId));
  const targets = new Map<string, Target>();
  for (const { candidate, prefix, row } of resolved) {
    if (!joined.has(row.userId)) continue;
    if (!targets.has(row.userId) && targets.size >= MENTION_NOTIFY_LIMIT) continue;
    const target = targets.get(row.userId) ?? { userId: row.userId, publicId: row.publicId, tokens: [] };
    if (!target.tokens.some(token => token.spelling === candidate.spelling)) target.tokens.push({ spelling: candidate.spelling, prefix });
    targets.set(row.userId, target);
  }
  return [...targets.values()];
}

// Current bindings are replaced, while told recipients survive edits and notification cleanup.
// A NULL notification timestamp is an active binding only; obsolete untold bindings can be removed.
export async function saveChatMentions(tx: Db, input: { messageId: string; villageId: string; authorId: string; targets: Target[]; replyAuthorId?: string | null; now: Date; isNew: boolean }) {
  const { messageId, villageId, authorId, now } = input;
  const targets = [...input.targets];
  // The reply recipient goes first and shares the durable once-per-message ledger with mentions.
  if (input.isNew && input.replyAuthorId) {
    const [member] = await tx.select({ userId: villageMembers.userId }).from(villageMembers)
      .where(and(eq(villageMembers.villageId, villageId), eq(villageMembers.userId, input.replyAuthorId))).for("share");
    const [profile] = member ? await tx.select({ publicId: profiles.publicId }).from(profiles).where(eq(profiles.userId, member.userId)) : [];
    if (member && profile) {
      const existing = targets.find(target => target.userId === member.userId);
      if (existing) targets.splice(targets.indexOf(existing), 1);
      targets.unshift(existing ?? { userId: member.userId, publicId: profile.publicId, tokens: [] });
    }
  }
  const old = input.isNew ? [] : await tx.select({ userId: chatMentions.userId, notifiedAt: chatMentions.notifiedAt }).from(chatMentions).where(eq(chatMentions.messageId, messageId));
  const told = new Set(old.filter(row => row.notifiedAt !== null).map(row => row.userId));
  if (!input.isNew) {
    await tx.delete(chatMentions).where(and(eq(chatMentions.messageId, messageId), isNull(chatMentions.notifiedAt)));
    await tx.update(chatMentions).set({ tokens: [] }).where(eq(chatMentions.messageId, messageId));
  }
  const created: Array<{ id: number; userId: string; kind: "chat_mention" | "chat_reply" }> = [];
  const [suspended] = targets.length ? await tx.select({ id: profiles.userId }).from(profiles).where(and(eq(profiles.userId, authorId), gt(profiles.suspendedUntil, now))) : [];
  const consented = new Set(targets.length ? (await tx.select({ userId: chatConsents.userId }).from(chatConsents)
    .where(and(eq(chatConsents.villageId, villageId), inArray(chatConsents.userId, targets.map(target => target.userId)), eq(chatConsents.version, CHAT_CONSENT_VERSION)))).map(row => row.userId) : []);
  for (const target of [...targets].sort((a, b) => a.userId.localeCompare(b.userId))) {
    await tx.insert(chatMentions).values({ messageId, userId: target.userId, publicId: target.publicId, tokens: target.tokens }).onConflictDoUpdate({ target: [chatMentions.messageId, chatMentions.userId], set: { tokens: target.tokens } });
  }
  // The reply recipient takes the first slot; remaining quota follows mention source order. Membership locks are held.
  const stopped = new Set(targets.length ? (await tx.select({ id: profiles.userId }).from(profiles)
    .where(and(inArray(profiles.userId, targets.map(target => target.userId)), gt(profiles.suspendedUntil, now)))).map(row => row.id) : []);
  for (const target of targets) {
    if (stopped.has(target.userId) || suspended || !consented.has(target.userId) || target.userId === authorId || told.has(target.userId) || told.size >= MENTION_NOTIFY_LIMIT) continue;
    await tx.update(chatMentions).set({ notifiedAt: now }).where(and(eq(chatMentions.messageId, messageId), eq(chatMentions.userId, target.userId)));
    told.add(target.userId);
    const kind = input.isNew && target.userId === input.replyAuthorId ? "chat_reply" : "chat_mention";
    const [row] = await tx.insert(notifications).values({ userId: target.userId, kind, villageId, chatMessageId: messageId, createdAt: now }).returning({ id: notifications.id });
    created.push({ id: row.id, userId: target.userId, kind });
  }
  await enqueueImmediateEmails(tx, created, { now });
}

export async function chatMentionTargets(db: Db, ids: readonly string[]): Promise<Map<string, Map<string, ChatMentionTarget>>> {
  const out = new Map<string, Map<string, ChatMentionTarget>>();
  if (!ids.length) return out;
  const rows = await db.select({ messageId: chatMentions.messageId, publicId: chatMentions.publicId, tokens: chatMentions.tokens }).from(chatMentions).where(inArray(chatMentions.messageId, [...ids]));
  for (const row of rows) {
    const targets = out.get(row.messageId) ?? new Map<string, ChatMentionTarget>();
    for (const token of row.tokens) targets.set(token.spelling, { prefix: token.prefix, href: `/u/id/${row.publicId}` });
    out.set(row.messageId, targets);
  }
  return out;
}
