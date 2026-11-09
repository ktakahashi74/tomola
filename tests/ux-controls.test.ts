import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { RouteError } from "~/components/route-error";
import { FollowButton } from "~/components/follow-button";
import { renderOfflinePage } from "~/lib/offline-page";
import { m } from "~/paraglide/messages.js";
import { renderInRouter } from "./helpers/render-in-router";
import { TranslationReportForm } from "~/components/translation-report-form";

const fetcher = vi.hoisted(() => ({ Form: "form", state: "idle", data: undefined as { intent: string; entryId: number; reported: boolean; reportId: number; lang: string } | undefined }));
afterEach(() => { fetcher.data = undefined; });

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
vi.mock("react-router", async original => ({ ...await original<typeof import("react-router")>(), useFetcher: () => fetcher }));

it("shows Following as a status and names the compact Unfollow action", () => {
  const html = renderToStaticMarkup(createElement(FollowButton, { threadId: 1, state: "following", returnTo: "/t/1", variant: "compact" }));
  expect(html).toContain('role="status"');
  expect(html).toMatch(new RegExp(`>${m.follow_unfollow()}</button>`));
});

it.each([[400, () => m.error_body_bad_request()], [503, () => m.error_body_unavailable()]] as const)("explains HTTP %s", async (status, message) => {
  const html = await renderInRouter(() => createElement(RouteError, { error: { status, statusText: "", internal: false, data: { retryAfter: "30" } } }));
  expect(html).toContain(message());
  if (status === 503) expect(html).toContain(m.error_retry_after({ time: "30 seconds" }));
});

it("keeps the maintenance-specific explanation for a readonly 503", async () => {
  const message = m.maintenance_readonly();
  const html = await renderInRouter(() => createElement(RouteError, { error: { status: 503, statusText: "", internal: false, data: { error: "maintenance_readonly", message } } }));
  expect(html).toContain(message);
  expect(html).not.toContain(m.error_body_unavailable());
});

it("reloads the current offline address without scripts", () => {
  const html = renderOfflinePage([{ lang: "en", title: "Offline", body: "No connection", home: "Home", reload: "Reload this page" }], "tomola");
  expect(html).toContain('<a href="">Reload this page</a>');
  expect(html).not.toContain("<script");
});

it("allows reporting a new current translation after the server closes the previous report", async () => {
  fetcher.data = { intent: "report", entryId: 1, reported: true, reportId: 7, lang: "en" };
  const report = { id: 7, lang: "en", field: "body", excerpt: "", note: "" };
  const render = (reports: typeof report[]) => renderInRouter(() => createElement(TranslationReportForm, { entryId: 1, lang: "en", kind: "reply", reports }));
  expect(await render([report])).toContain(m.report_reported());
  const updated = await render([]);
  expect(updated).toContain(m.report_button());
  expect(updated).not.toContain(m.report_reported());
});

it("keeps persisted translation report details closed on a fresh page", async () => {
  const html = await renderInRouter(() => createElement(TranslationReportForm, { entryId: 1, lang: "en", kind: "reply", inline: true, reports: [{ id: 7, lang: "en", field: "body", excerpt: "phrase", note: "explanation" }] }));
  expect(html).toContain(m.report_optional_summary());
  expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
  expect(html).toContain("explanation");
});

it("shows optional reply details only after reporting", async () => {
  const html = await renderInRouter(() => createElement(TranslationReportForm, { entryId: 1, lang: "en", kind: "reply", inline: true }));
  expect(html).toContain(m.report_button());
  expect(html).not.toContain(m.report_optional_summary());
  expect(html).toMatch(/<button(?=[^>]*name="field")(?=[^>]*value="body")/);
  expect(html).not.toContain(m.report_title_button());
});

it("offers the body and the title of a post with a title as two separate reports, and reporting one leaves the other open", async () => {
  const fresh = await renderInRouter(() => createElement(TranslationReportForm, { entryId: 1, lang: "en", kind: "topic" }));
  expect(fresh).toContain(m.report_button());
  expect(fresh).toContain(m.report_title_button());
  expect(fresh).not.toContain(m.report_optional_summary());
  const html = await renderInRouter(() => createElement(TranslationReportForm, { entryId: 1, lang: "en", kind: "topic", reports: [{ id: 7, lang: "en", field: "title", excerpt: "title", note: "title explanation" }] }));
  expect(html).toContain(m.report_button());
  expect(html).not.toContain(m.report_title_button());
  expect(html).toContain(m.report_reported());
  // Only the title is reported, so the details are the title's and there is no choice of part.
  expect(html).toContain("title explanation");
  expect(html).not.toContain(m.report_field());
  const both = await renderInRouter(() => createElement(TranslationReportForm, { entryId: 1, lang: "en", kind: "topic", reports: [{ id: 7, lang: "en", field: "title", excerpt: "", note: "" }, { id: 8, lang: "en", field: "body", excerpt: "", note: "" }] }));
  expect(both).toContain(m.report_field());
});

it("offers no title button for a post without a title or for a reply", async () => {
  for (const props of [{ kind: "topic" as const, hasTitle: false }, { kind: "reply" as const }]) {
    const html = await renderInRouter(() => createElement(TranslationReportForm, { entryId: 1, lang: "en", ...props }));
    expect(html).not.toContain(m.report_title_button());
    expect(html).not.toContain('value="title"');
  }
});
