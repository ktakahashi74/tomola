import { noticesAvailable } from "~/lib/notices.server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { profiles, user } from "~/lib/db/schema";
import { getMailer, type Mailer } from "~/lib/mail/mail.server";
import { memberMailLocale } from "~/lib/mail/magic-link.server";
import { siteUrl } from "~/lib/site-url";
import { m } from "~/paraglide/messages.js";
import type { JobHandlers } from "./queue.server";
import { SEND_PASSKEY_NOTICE_JOB } from "./mail-kinds";

const payload = z.object({ userId: z.string(), action: z.enum(["added", "removed", "recovery"]), name: z.string(), at: z.string().datetime() });
export function createPasskeyHandlers(mailer: () => Mailer = getMailer): JobHandlers {
  return { [SEND_PASSKEY_NOTICE_JOB]: async (job, { db }) => {
    const data = payload.parse(job.payload);
    const [account] = await db.select({ email: user.email, locale: profiles.uiLocale, homeArea: profiles.homeArea }).from(user).leftJoin(profiles, eq(profiles.userId, user.id)).where(eq(user.id, data.userId));
    if (!account) return;
    const locale = { locale: memberMailLocale(account.locale, account.homeArea) };
    const text = data.action === "added" ? m.passkey_notice_added({ name: data.name, at: data.at }, locale)
      : data.action === "removed" ? m.passkey_notice_removed({ name: data.name, at: data.at }, locale)
      : m.passkey_notice_recovery({ at: data.at }, locale);
    await mailer().send({ to: account.email, locale: locale.locale, subject: m.passkey_notice_subject({}, locale), text: `${text}\n\n${new URL("/settings", siteUrl()).href}${noticesAvailable().privacy ? `\n\n${new URL("/privacy#s6", siteUrl()).href}` : ""}` });
  } };
}
