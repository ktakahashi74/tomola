import { operatorConfig } from "~/lib/operator-config.server";
import { eq } from "drizzle-orm";
import { accountDeletions, jobs } from "~/lib/db/schema";
import { defaultUiLocale } from "~/lib/enabled-langs.server";
import { getMailer, type Mailer } from "~/lib/mail/mail.server";
import { mailLocale } from "~/lib/mail/magic-link.server";
import { RETENTION, daysBefore } from "~/lib/retention";
import { m } from "~/paraglide/messages.js";
import type { JobHandlers } from "./queue.server";
import { SEND_ACCOUNT_DELETED_JOB } from "./mail-kinds";

export function createAccountDeletionHandlers(mailer: () => Mailer = getMailer): JobHandlers {
  return { [SEND_ACCOUNT_DELETED_JOB]: async (job, { db, now }) => {
    const payload = job.payload as { requestId?: string; to?: string; posts?: string; locale?: string };
    if (!payload.requestId) throw new Error("Invalid account deletion notice");
    const [request] = await db.select().from(accountDeletions).where(eq(accountDeletions.id, payload.requestId));
    if (!request || request.state !== "completed") throw new Error("Account deletion is not completed");
    const erase = async (state: "sent" | "failed") => db.transaction(async tx => {
      await tx.update(jobs).set({ payload: { requestId: request.id } }).where(eq(jobs.id, job.id));
      await tx.update(accountDeletions).set({ noticeState: state, updatedAt: now }).where(eq(accountDeletions.id, request.id));
    });
    if (request.noticeState === "sent") { await erase("sent"); return; }
    if (!payload.to || job.createdAt < daysBefore(now, RETENTION.finishedJobDays)) { await erase("failed"); return; }
    try {
      const locale = { locale: mailLocale(payload.locale) ?? defaultUiLocale() };
      const posts = request.posts === "delete" ? m.account_delete_mail_delete({}, locale) : m.account_delete_mail_keep({}, locale);
      await mailer().send({ to: payload.to, locale: locale.locale, subject: m.account_delete_mail_subject({}, locale), text: m.account_delete_mail_body({ posts, email: operatorConfig().privacyEmail }, locale) });
      await erase("sent");
    } catch {
      if (job.attempts >= job.maxAttempts) await erase("failed");
      throw new Error("Account deletion notice delivery failed");
    }
  } };
}
