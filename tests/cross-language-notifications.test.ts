import { createElement } from "react";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entries, profiles, translations } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { createNotificationHandlers } from "~/lib/jobs/notification-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { localizedLanguageLabel } from "~/lib/language-label";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import Notifications, { loader } from "~/routes/notifications";
import { m } from "~/paraglide/messages.js";
import { setupRouteHarness } from "./helpers/route-harness";
import { renderInRouter } from "./helpers/render-in-router";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { quietLogger } from "./helpers/logger";
import { messageMarkup } from "./helpers/message-markup";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => { setTestLocale("en"); vi.unstubAllEnvs(); });

describe("reply language in screen and email notifications", () => {
  for (const kind of ["reply_to_topic", "reply_to_reply"] as const) {
    for (const locale of ["en", "ja"] as const) {
      it.each(["ja", "en", "other"] as const)(`${kind} uses the original language and ${locale} names for a %s recipient`, async homeArea => {
        const h = await setupRouteHarness();
        try {
          await h.signIn("cross_recipient", { homeArea, readLangs: ["ja", "en"] });
          await h.signIn("cross_actor", { homeArea: "en" });
          const recipient = h.ids.cross_recipient;
          await h.db.update(profiles).set({ uiLocale: locale, displayLang: "en", emailPref: "immediate" }).where(eq(profiles.userId, recipient));
          const topic = await createTopic(h.db, recipient, { lang: "ja", title: "Topic", body: "Topic body" });
          if (!topic.ok) throw new Error("topic failed");
          let parentId: number | undefined;
          if (kind === "reply_to_reply") {
            const parent = await createReply(h.db, recipient, topic.id, { lang: "ja", body: "Parent reply" });
            if (!parent.ok) throw new Error("parent failed");
            parentId = parent.id;
          }
          const reply = await createReply(h.db, h.ids.cross_actor, topic.id, { lang: "ja", body: "原文の返信", parentId });
          if (!reply.ok) throw new Error("reply failed");
          const [source] = await h.db.select().from(entries).where(eq(entries.id, reply.id));
          await h.db.insert(translations).values({ entryId: reply.id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: "Translated excerpt" });
          setTestLocale(locale);
          const data = await loader(h.args(h.request("/notifications", { as: "cross_recipient" })));
          const html = await renderInRouter(() => createElement(Notifications, { loaderData: data } as never));
          const cross = homeArea !== "ja";
          const params = { handle: "cross_actor", title: "Topic", language: localizedLanguageLabel("ja", locale) };
          const expected = kind === "reply_to_topic"
            ? cross ? m.notification_reply_to_topic_language(params, { locale }) : m.notification_reply_to_topic(params, { locale })
            : cross ? m.notification_reply_to_reply_language(params, { locale }) : m.notification_reply_to_reply(params, { locale });
          expect(html).toContain(messageMarkup(expected));
          expect(data.items[0].entryLang).toBe("ja");
          const box = createMemoryMailbox();
          const handlers = createNotificationHandlers({ mailer: () => createMailer(box.transport, "no-reply@example.org") });
          const result = await runDueJobs(h.db, handlers, { now: new Date(Date.now() + 360_000), logger: quietLogger });
          expect(result.failed).toBe(0);
          expect(box.sent).toHaveLength(1);
          const mail = kind === "reply_to_topic"
            ? cross ? m.mail_item_reply_to_topic_language({ ...params, excerpt: "", url: "" }, { locale }) : m.mail_item_reply_to_topic({ ...params, excerpt: "", url: "" }, { locale })
            : cross ? m.mail_item_reply_to_reply_language({ ...params, excerpt: "", url: "" }, { locale }) : m.mail_item_reply_to_reply({ ...params, excerpt: "", url: "" }, { locale });
          expect(box.sent[0].text).toContain(mail.split("\n\n")[0]);
          expect(box.sent[0].text).toContain("Translated excerpt");
          // Suppressed content must expose neither its source language nor its author.
          await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, reply.id));
          const hidden = await loader(h.args(h.request("/notifications", { as: "cross_recipient" })));
          expect(hidden.items[0]).toMatchObject({ entryLang: null, unavailable: true });
          expect(await renderInRouter(() => createElement(Notifications, { loaderData: hidden } as never))).toContain(m.notification_reply_unavailable({}, { locale }));
        } finally { h.restore(); }
      });
    }
  }
});
