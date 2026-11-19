import { onboardingData } from "./helpers/loader-fixtures";
import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { shellLabels } from "~/lib/shell-labels.server";
import { noticesAvailable, trialParticipationRequired } from "~/lib/notices.server";
import { testOperator } from "./helpers/operator";
import { renderInRouter } from "./helpers/render-in-router";
import { addMember, createTestDb } from "./helpers/db";
import type { MailMessage } from "~/lib/mail/mail.server";
import { routeElement } from "./helpers/route-fixtures";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
const args = (url: string) => ({ request: new Request(`http://localhost${url}`), params: {}, context: {} }) as never;

it("serves the configured notices in HTML and Markdown, with matching footer and signup links", async () => {
  expect(noticesAvailable()).toEqual({ privacy: true, terms: true });
  expect(trialParticipationRequired()).toBe(true);
  for (const kind of ["privacy", "terms"] as const) {
    const privacy = await import("~/routes/privacy");
    const terms = await import("~/routes/terms");
    const page = kind === "privacy" ? privacy : terms;
    const md = kind === "privacy" ? await import("~/routes/privacy-md") : await import("~/routes/terms-md");
    const loaded = await page.loader(args(`/${kind}?lang=en`));
    expect(loaded).toMatchObject({ lang: "en", fallback: false });
    expect(await md.loader(args(`/${kind}.md?lang=en`)).text()).toContain(loaded.markdown);
    const html = kind === "privacy"
      ? await renderInRouter(() => routeElement(privacy.default, { loaderData: loaded }))
      : await renderInRouter(() => routeElement(terms.default, { loaderData: loaded }));
    expect(html).toContain('id="s1"');
  }
  const { SiteFooter } = await import("~/components/site-footer");
  const footer = await renderInRouter(() => createElement(SiteFooter, { labels: shellLabels(), privacyLabel: "Privacy", sourceUrl: null }));
  expect(footer).toContain('href="/privacy"');
  expect(footer).toContain('href="/privacy#s1"');
  expect(footer).toContain(testOperator.name.en);
  const onboarding = await import("~/routes/onboarding");
  const html = await renderInRouter(() => routeElement(onboarding.default, { loaderData: onboardingData({ defaultMainLang: "en", notices: noticesAvailable(), trialRequired: true }) }));
  for (const href of ["/privacy", "/terms"]) expect(html).toContain(`href="${href}"`);
  expect(html).toContain(testOperator.participation.copy.en.eligibilitySummary);
  expect(html).toContain('name="trialAgree"');
  expect(html).toContain('name="residenceCountry"');
});

it("passkey notification mail links to the configured public privacy notice", async () => {
  const db = await createTestDb();
  await addMember(db, "notice_mail", "notice_mail");
  const { createPasskeyHandlers } = await import("~/lib/jobs/passkey-jobs.server");
  const { enqueue, runDueJobs } = await import("~/lib/jobs/queue.server");
  const sent: MailMessage[] = [];
  const now = new Date();
  await enqueue(db, "send_passkey_notice", { userId: "notice_mail", action: "added", name: "Key", at: now.toISOString() }, { runAt: now });
  const handlers = createPasskeyHandlers(() => ({ kind: "memory", from: "test@example.invalid", send: async message => { sent.push(message); } }));
  expect(await runDueJobs(db, handlers, { now: new Date(now.getTime() + 1000) })).toMatchObject({ done: 1 });
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toContain("/privacy#s6");
});
