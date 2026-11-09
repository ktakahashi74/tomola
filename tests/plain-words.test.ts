import { createElement } from "react";
import { renderInRouter } from "./helpers/render-in-router";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { setTestMessages } from "./stubs/paraglide-messages";
import { jsonMessages } from "./helpers/messages-json";
import { EntryFields } from "~/components/entry-fields";
import { TranslationReportForm } from "~/components/translation-report-form";
import { languageLabel } from "~/lib/language-label";
import { LANGS } from "~/lib/languages";
import { hasLogoutNotice, logoutNoticeCookie, logoutNoticeMiddleware } from "~/lib/auth/logout-notice.server";
import Invite, { meta as inviteMeta } from "~/routes/invite";
import Login from "~/routes/login";
import Notifications from "~/routes/notifications";
import { meta as topicMeta } from "~/routes/topic";
import { m } from "~/paraglide/messages.js";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { messageMarkup } from "./helpers/message-markup";

beforeEach(() => setTestMessages(jsonMessages()));
vi.mock("~/lib/use-enabled-langs", () => ({ useEnabledLangs: () => ["ja", "en"] }));
afterEach(() => { setTestLocale("en"); setTestMessages(); });
const render = (element: React.ReactElement) => renderInRouter(() => element, "/t/1");

it("keeps all writing help in one closed disclosure, outside the body label", async () => {
  const html = await render(createElement(EntryFields, { defaultLang: "en", pasteFrontmatter: "reply" }));
  const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g)!.find(part => part.includes(m.writing_tips()))!;
  expect(details).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  const positions = [m.writing_math_help(), m.related_link_help(), m.footer_connect()].map(messageMarkup).map(text => details.indexOf(text));
  expect(details).toContain('href="/connect" target="_blank"');
  // Nothing in the writing help is about frontmatter: that belongs to the guide for AI clients.
  expect(details).not.toContain("frontmatter");
  expect(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]))).toBe(true);
  expect(html).toMatch(new RegExp(`<label[^>]*for="[^"]+"[^>]*>${messageMarkup(m.field_body())}</label>`));
});
it("shows the invitation note on the same login form for every recipient", async () => {
  const html = await render(createElement(Login, { loaderData: { next: "/", codePending: null, loggedOut: false } } as never));
  expect(html).toContain(messageMarkup(m.login_invitation_short()));
  expect(html.indexOf(messageMarkup(m.login_invitation_short()))).toBeGreaterThan(html.indexOf(messageMarkup(m.login_submit())));
});
it("uses interface messages for all supported post languages", () => {
  for (const locale of ["ja", "en"] as const) {
    setTestLocale(locale);
    const expected = [m.language_name_ja(), m.language_name_en(), m.language_name_fr(), m.language_name_de(), m.language_name_zh_hant(), m.language_name_zh_hans(), m.language_name_ko(), m.language_name_th(), m.language_name_vi()];
    expect(LANGS.map(languageLabel)).toEqual(expected);
  }
});
it("gives unusable invitations a matching page and document title without an address", async () => {
  const loaderData = { email: null, codePending: null };
  const html = await render(createElement(Invite, { loaderData } as never));
  expect(html).toContain(messageMarkup(m.invite_unusable_title()));
  expect(html).not.toContain(messageMarkup(m.invite_title()));
  expect(inviteMeta({ loaderData } as never)).toEqual([{ title: m.invite_unusable_title() }]);
});
it("reports a translation in one press, and offers the optional details only after a report", async () => {
  const first = await render(createElement(TranslationReportForm, { entryId: 1, kind: "reply", lang: "en" }));
  expect(first).toContain(messageMarkup(m.report_button()));
  expect(first).not.toContain("<details");
  expect(first).toMatch(/<button(?=[^>]*name="field")(?=[^>]*value="body")/);
  const reported = await render(createElement(TranslationReportForm, { entryId: 1, kind: "reply", lang: "en", reports: [{ id: 7, lang: "en", field: "body", excerpt: "", note: "" }] }));
  const details = reported.match(/<details\b[^>]*>[\s\S]*?<\/details>/)![0];
  expect(details).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  expect(details).toContain(messageMarkup(m.report_optional_summary()));
});
it("shortens only titleless document titles, including supplementary Unicode characters", () => {
  const line = "🌿".repeat(70);
  const meta = (title: string | null) => topicMeta({ loaderData: { topic: { id: 1, placeholder: null, title, headline: line, display: { shown: "original" } } }, location: { search: "" } } as never).flatMap(item => "title" in item ? [item.title] : [])[0];
  expect(meta(null)).toBe("🌿".repeat(40) + "…");
  expect(meta(line)).toBe(line);
});
it("consumes the logout flash on GET responses and retains it through the logout POST", async () => {
  const request = new Request("https://example.com/login", { headers: { cookie: "tomola.logged-out=1" } });
  expect(hasLogoutNotice(request)).toBe(true);
  expect(logoutNoticeCookie(request, true)).toContain("HttpOnly; SameSite=Lax; Max-Age=60; Secure");
  const response = await logoutNoticeMiddleware({ request } as never, (async () => Promise.resolve(new Response("screen"))) as never) as Response;
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const post = new Request(request.url, { method: "POST", headers: request.headers });
  const untouched = await logoutNoticeMiddleware({ request: post } as never, (async () => Promise.resolve(new Response("screen"))) as never) as Response;
  expect(untouched.headers.get("set-cookie")).toBeNull();
});
it("links empty notifications to email settings and omits the link for a populated page", async () => {
  const html = await render(createElement(Notifications, { loaderData: { items: [], page: 1, hasNext: false } } as never));
  expect(html).toContain(messageMarkup(m.notifications_empty()));
  expect(html).toContain('href="/settings#settings-email"');
  expect(html).toContain(messageMarkup(m.notifications_email_settings()));
});
