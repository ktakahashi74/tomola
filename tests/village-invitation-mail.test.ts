import { enqueueImmediateEmails } from "~/lib/notifications.server";
import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { notifications, profiles, villageInvites, villages } from "~/lib/db/schema";
import { createVillage, inviteToVillage } from "~/lib/village-management.server";
import { ensureLanguageVillages } from "~/lib/villages.server";
import { createNotificationHandlers, ensureDigestScheduled } from "~/lib/jobs/notification-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { deleteAccount } from "~/lib/account-delete.server";
import { m } from "~/paraglide/messages.js";

vi.hoisted(() => vi.resetModules());
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

afterEach(() => vi.unstubAllEnvs());

it.each((["immediate", "daily"] as const).flatMap(emailPref => (["native", "latin", "handle", "departed"] as const).map(name => [emailPref, name] as const)))("delivers the historical adding actor with %s delivery and %s naming", async (emailPref, name) => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
  const db = await createTestDb(); await ensureLanguageVillages(db);
  await addMember(db, "direct_mail_owner", "direct_mail_owner", { homeArea: "en" });
  await addMember(db, "direct_mail_guest", "direct_mail_guest", { homeArea: "en" });
  await db.update(profiles).set({ emailPref, uiLocale: name === "native" ? "ja" : "en" }).where(eq(profiles.userId, "direct_mail_guest"));
  if (name !== "handle") await db.update(profiles).set({ displayName: "招待の持ち主", displayNameLatin: "Inviting Owner", homeArea: "ja" }).where(eq(profiles.userId, "direct_mail_owner"));
  await createVillage(db, "direct_mail_owner", { slug: "direct-mail", name: "Direct mail", description: "", kind: "invite_public" });
  const [village] = await db.select().from(villages).where(eq(villages.slug, "direct-mail"));
  const [notice] = await db.insert(notifications).values({ userId: "direct_mail_guest", actorId: "direct_mail_owner", villageId: village.id, kind: "village_added" }).returning();
  await enqueueImmediateEmails(db, [{ ...notice, kind: "village_added" }]);
  if (name === "departed") {
    const [village] = await db.select().from(villages).where(eq(villages.slug, "direct-mail"));
    await deleteAccount(db, "direct_mail_owner", { confirmation: "direct_mail_owner", villages: { [village.id]: "end" } });
  }
  const createdAt = new Date(), now = emailPref === "daily"
    ? new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate() + 1)) : new Date(createdAt.getTime() + 360000);
  if (emailPref === "daily") await ensureDigestScheduled(db, createdAt);
  const box = createMemoryMailbox(), handlers = createNotificationHandlers({ mailer: () => createMailer(box.transport, "tomola <no-reply@example.org>") });
  expect(await runDueJobs(db, handlers, { now, limit: 20, logger: { error() {}, warn() {} } })).toMatchObject({ failed: 0 });
  expect(box.sent).toHaveLength(1);
  expect(box.sent[0].text).toContain("/notifications");
  expect(box.sent[0].text).toContain(name === "departed" ? m.account_delete_member({}, { locale: "en" }) : name === "native" ? "招待の持ち主" : name === "latin" ? "Inviting Owner" : "@direct_mail_owner");
  if (name === "departed") expect(box.sent[0].text).not.toContain("direct_mail_owner");
  expect((await db.select().from(notifications).where(eq(notifications.userId, "direct_mail_guest")))[0]).toMatchObject({ kind: "village_added", emailedAt: expect.any(Date) });
});

it.each(["immediate", "daily"] as const)("only mails pending invitations in active villages with %s delivery", async emailPref => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
  const db = await createTestDb(); await ensureLanguageVillages(db);
  await addMember(db, "mail_owner", "vm_mail_owner", { homeArea: "en" });
  await addMember(db, "mail_guest", "vm_mail_guest", { homeArea: "en" });
  await db.update(profiles).set({ emailPref }).where(eq(profiles.userId, "mail_guest"));
  for (const state of ["pending", "cancelled", "declined", "accepted", "ended"] as const) {
    const slug = `mail-${state}`;
    expect(await createVillage(db, "mail_owner", { slug, name: slug, description: "", kind: "invite_public" })).toMatchObject({ ok: true });
    expect(await inviteToVillage(db, "mail_owner", slug, "vm_mail_guest", "join")).toMatchObject({ ok: true });
  }
  const invitations = await db.select({ id: villageInvites.id, slug: villages.slug }).from(villageInvites).innerJoin(villages, eq(villages.id, villageInvites.villageId));
  for (const state of ["cancelled", "declined", "accepted"] as const) {
    await db.update(villageInvites).set({ state, respondedAt: new Date() }).where(eq(villageInvites.id, invitations.find(row => row.slug === `mail-${state}`)!.id));
  }
  // An independently ended village must suppress even a still-pending row.
  await db.update(villages).set({ endedAt: new Date() }).where(eq(villages.slug, "mail-ended"));
  const createdAt = new Date();
  const now = emailPref === "daily" ? new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate() + 1)) : new Date(createdAt.getTime() + 360000);
  if (emailPref === "daily") await ensureDigestScheduled(db, createdAt);
  const box = createMemoryMailbox();
  const handlers = createNotificationHandlers({ mailer: () => createMailer(box.transport, "tomola <no-reply@example.org>") });
  expect(await runDueJobs(db, handlers, { now, limit: 20, logger: { error() {}, warn() {} } })).toMatchObject({ failed: 0 });
  expect(box.sent).toHaveLength(1);
  const rows = await db.select().from(notifications).where(eq(notifications.userId, "mail_guest"));
  expect(rows).toHaveLength(5);
  expect(rows.every(row => row.emailedAt !== null)).toBe(true);
  // A digest still has exactly one item; suppressed invitations add no content.
  if (emailPref === "daily") expect(box.sent[0].subject).toContain("1");
}, 30000);
