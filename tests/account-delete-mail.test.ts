import { testOperator } from "./helpers/operator";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { deleteAccount } from "~/lib/account-delete.server";
import { accountDeletions, jobs } from "~/lib/db/schema";
import { createAccountDeletionHandlers } from "~/lib/jobs/account-delete-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { addMember, createTestDb } from "./helpers/db";
import { m } from "~/paraglide/messages.js";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

it.each(["en", "ja"])("sends the %s notice after completion, says chat is deleted, and erases the delivery address", async locale => {
  const db = await createTestDb(); await addMember(db, "notice-user", "quit_notice");
  const { profiles } = await import("~/lib/db/schema");
  await db.update(profiles).set({ uiLocale: locale }).where(eq(profiles.userId, "notice-user"));
  await deleteAccount(db, "notice-user", { confirmation: "quit_notice", posts: "delete" });
  const mailbox = createMemoryMailbox(); const mailer = createMailer(mailbox.transport, "noreply@example.com");
  expect(mailbox.sent).toEqual([]);
  const result = await runDueJobs(db, createAccountDeletionHandlers(() => mailer));
  expect(result.done).toBe(1);
  expect(mailbox.sent).toHaveLength(1);
  expect(mailbox.sent[0]).toMatchObject({ to: "notice-user@example.com", subject: m.account_delete_mail_subject({}, { locale: locale as "en" | "ja" }) });
  expect(mailbox.sent[0].text).toContain(testOperator.privacyEmail);
  expect(mailbox.sent[0].text).toContain(locale === "ja" ? "チャットの発言は、すべて消しました" : "All your chat messages have been deleted");
  expect(JSON.stringify(await db.select().from(jobs))).not.toContain("notice-user@example.com");
  expect((await db.select().from(accountDeletions))[0].noticeState).toBe("sent");
});

it("redacts the address on the last delivery failure while keeping a retryable operator record", async () => {
  const db = await createTestDb(); await addMember(db, "notice-fail", "quit_failed_notice");
  await deleteAccount(db, "notice-fail", { confirmation: "quit_failed_notice" });
  await db.update(jobs).set({ maxAttempts: 1 });
  await runDueJobs(db, createAccountDeletionHandlers(() => ({ kind: "memory", from: "noreply@example.com", send: async () => { throw new Error("private SMTP failure notice-fail@example.com"); } })), { logger: { warn() {}, error() {} } });
  const [request] = await db.select().from(accountDeletions);
  expect(request).toMatchObject({ state: "completed", noticeState: "failed", userId: null });
  const rows = await db.select().from(jobs);
  expect(rows[0].status).toBe("failed");
  expect(JSON.stringify(rows)).not.toContain("notice-fail@example.com");
});
