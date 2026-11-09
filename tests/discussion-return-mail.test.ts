import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { entries, profiles } from "~/lib/db/schema";
import { createReply, createTopic, softDeleteEntry } from "~/lib/entries.server";
import { setFollow } from "~/lib/follows.server";
import { createNotificationHandlers, ensureDigestScheduled } from "~/lib/jobs/notification-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { addMember, createTestDb } from "./helpers/db";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

for (const mode of ["immediate", "daily"] as const) for (const state of ["visible", "first-deleted", "latest-hidden", "both-hidden"] as const) {
  it(`${mode} mail uses the first readable unread reply with safe fallback (${state})`, async () => {
    const db = await createTestDb();
    for (const id of ["author", "writer", "reader"]) await addMember(db, id, id, { readLangs: ["en"], email: `${id}@example.com` });
    await db.update(profiles).set({ emailPref: "none" });
    await db.update(profiles).set({ emailPref: mode, uiLocale: "en" }).where(eq(profiles.userId, "reader"));
    const now = new Date("2030-01-01T12:00:00Z");
    const topic = await createTopic(db, "author", { lang: "en", title: "Mail destination", body: "Topic" }, { now });
    if (!topic.ok) throw new Error(topic.error);
    await setFollow(db, "reader", topic.id, true);
    const first = await createReply(db, "writer", topic.id, { lang: "en", body: "First unread" }, { now });
    const latest = await createReply(db, "writer", topic.id, { lang: "en", body: "Latest unread" }, { now: new Date(now.getTime() + 1000) });
    if (!first.ok || !latest.ok) throw new Error("reply failed");
    if (state === "first-deleted" || state === "both-hidden") await softDeleteEntry(db, first.id);
    if (state === "latest-hidden" || state === "both-hidden") await db.update(entries).set({ hiddenAt: now }).where(eq(entries.id, latest.id));
    const box = createMemoryMailbox();
    const handlers = createNotificationHandlers({ mailer: () => createMailer(box.transport, "tomola <no-reply@example.org>") });
    if (mode === "daily") await ensureDigestScheduled(db, now);
    await runDueJobs(db, handlers, { now: new Date("2030-01-02T00:00:00Z"), logger: { error: () => {}, warn: () => {} } });
    const mail = box.sent.filter(item => item.to === "reader@example.com");
    expect(mail).toHaveLength(1);
    const target = state === "both-hidden" ? "" : `#c-${state === "first-deleted" ? latest.id : first.id}`;
    expect(mail[0].text.match(/http:\/\/localhost:5173\/t\/\d+(?:\?[^\s#]*)?(?:#c-\d+)?/)?.[0]).toBe(`http://localhost:5173/t/${topic.id}${target}`);
    if (state === "latest-hidden" || state === "both-hidden") expect(mail[0].text).not.toContain("Latest unread");
  });
}
