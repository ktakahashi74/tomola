import * as routerHooks from "react-router";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, type StaticHandlerContext } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pagination } from "~/components/pagination";
import { EntryReactions } from "~/components/reactions";
import { ReasonsPanel, type ReasonView } from "~/components/reasons-panel";
import { RepliesFilter } from "~/components/stance-tag";
import { languageLabel } from "~/lib/language-label";
import { LANG_LABELS } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";
import { pickReactions, type ReactionsView } from "~/lib/vote-ui";
import { escapeRegex, messageMarkup } from "./helpers/message-markup";
import { jsonMessages } from "./helpers/messages-json";
import { setTestMessages } from "./stubs/paraglide-messages";
import { setTestLocale } from "./stubs/paraglide-runtime";

// The "Insightful" button, its count and the reasons panel as the page draws them. The real messages/*.json are used (the ordinary tests blank the messages).
beforeEach(() => setTestMessages(jsonMessages()));
vi.mock("react-router", async importOriginal => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useFetcher: vi.fn(actual.useFetcher), useLoaderData: vi.fn(actual.useLoaderData), useRouteLoaderData: vi.fn(actual.useRouteLoaderData), useMatches: vi.fn(actual.useMatches), useActionData: vi.fn(actual.useActionData) };
});
afterEach(() => { setTestLocale("en"); setTestMessages(); });

// The components use fetchers and the location, so they are drawn inside a static router.
async function render(element: ReactElement, url = "/t/12"): Promise<string> {
  const routes = [{ path: "/t/:id", Component: () => element }];
  const handler = createStaticHandler(routes);
  const context = (await handler.query(new Request(`http://localhost${url}`))) as StaticHandlerContext;
  const router = createStaticRouter(routes, context);
  return renderToStaticMarkup(createElement(StaticRouterProvider, { router, context }));
}

const none: ReactionsView = { insightful: { total: 0, langs: 0 }, mine: false };
const some: ReactionsView = { insightful: { total: 9, langs: 3 }, mine: false };
const pressed: ReactionsView = { insightful: { total: 9, langs: 3 }, mine: true };
const reactions = (props: Partial<Parameters<typeof EntryReactions>[0]> & { reactions: ReactionsView }) =>
  render(createElement(EntryReactions, { entryId: 5, canVote: true, anchor: "#c-5", ...props }));

describe("the Insightful button and its count", () => {
  it("is named Insightful (なるほど in Japanese), says what it means, and shows the total with the number of languages", async () => {
    const out = await reactions({ reactions: some });
    expect(out).toContain(`>${messageMarkup(m.insightful_give())}</button>`);
    expect(out).toContain(messageMarkup(m.insightful_help()));
    expect(out).toContain(`>${messageMarkup(m.insightful_count_short({ total: 9, langs: 3 }))}</span>`);
    expect(out).toContain(`<span class="sr-only">${messageMarkup(m.insightful_count_aria({ total: 9, langs: 3 }))}</span>`);
    setTestLocale("ja");
    const ja = await reactions({ reactions: some });
    expect(ja).toContain(`>${messageMarkup(m.insightful_give())}</button>`);
    expect(ja).toContain(messageMarkup(m.insightful_help()));
    expect(ja).toContain(`>${messageMarkup(m.insightful_count_short({ total: 9, langs: 3 }))}</span>`);
  });

  it("shows the pressed state with aria-pressed, and sends the opposite of what is shown", async () => {
    const off = await reactions({ reactions: some });
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('name="on" value="1"');
    const on = await reactions({ reactions: pressed });
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('name="on" value="0"');
    // what is sent: the post, the page to come back to without JavaScript (with the anchor), and the action
    expect(on).toContain('name="entryId" value="5"');
    expect(on).toContain('name="returnTo" value="/t/12#c-5"');
    expect(on).toContain('action="/vote"');
  });

  it("shows no count when nobody pressed it, and no button on a post of one's own (the count stays)", async () => {
    expect(await reactions({ reactions: none })).not.toContain(messageMarkup(m.insightful_count({ total: 0, langs: 0 })));
    expect(await reactions({ reactions: none })).not.toContain(messageMarkup(m.insightful_count_short({ total: 0, langs: 0 })));
    const own = await reactions({ reactions: some, canVote: false });
    expect(own).not.toContain("<button");
    expect(own).toContain(messageMarkup(m.insightful_count({ total: 9, langs: 3 })));
  });

  it("has no count per language, no language name, no vote and no cross-area wording", async () => {
    for (const locale of ["en", "ja"] as const) {
      setTestLocale(locale);
      const out = await reactions({ reactions: pressed, reviewHref: "/t/12?review=5#stance" });
      for (const name of Object.values(LANG_LABELS)) expect(out).not.toContain(name);
      expect(out).not.toMatch(/\bVotes?\b|Cross-area|越境|評価|票/);
    }
    // the props have no place for a count per language
    const contract = () => [
      // @ts-expect-error: a count per language is not a property of the Insightful state
      createElement(EntryReactions, { entryId: 5, canVote: true, anchor: "#c-5", reactions: { insightful: { total: 1, langs: 1, byArea: [] }, mine: false } }),
      // @ts-expect-error: the old per-area votes are gone
      createElement(EntryReactions, { entryId: 5, canVote: true, anchor: "#c-5", reactions: { votes: [], mine: false, crossArea: 0 } }),
    ];
    expect(typeof contract).toBe("function");
  });

  it("shows 'Reconsider my stance' next to a pressed button when the page gives the link, and nowhere else; it does not urge a change", async () => {
    const href = "/t/12?review=5#stance";
    const linked = await reactions({ reactions: pressed, reviewHref: href });
    expect(linked).toContain(`href="${href}"`);
    expect(linked).toContain(messageMarkup(m.insightful_review()));
    // not pressed, no link from the page, or no button at all (own post): no link
    expect(await reactions({ reactions: some, reviewHref: href })).not.toContain(messageMarkup(m.insightful_review()));
    expect(await reactions({ reactions: pressed })).not.toContain(messageMarkup(m.insightful_review()));
    expect(await reactions({ reactions: pressed, reviewHref: href, canVote: false })).not.toContain(messageMarkup(m.insightful_review()));
    setTestLocale("ja");
    expect(await reactions({ reactions: pressed, reviewHref: href })).toContain(messageMarkup(m.insightful_review()));
    // No sentence that asks the reader to change anything: the link text is all there is.
    const text = (await reactions({ reactions: pressed, reviewHref: href })).replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/変え(て|ましょう|るべき)|すべき|ぜひ|should|please|consider changing|change your/i);
  });

  it("shares a keyed fetcher for the same post while separate posts keep distinct state", async () => {
    const fetcher = vi.mocked(routerHooks.useFetcher);
    fetcher.mockClear();
    const loaderHooks = ["useLoaderData", "useRouteLoaderData", "useMatches", "useActionData"] as const;
    const guards = loaderHooks.map(name => vi.mocked(routerHooks[name]).mockImplementation(() => { throw new Error("Reactions must use the state passed by their parent"); }));
    try {
      await render(createElement("div", null, ...[5, 5, 6].map((entryId, key) => createElement(EntryReactions, { key, entryId, canVote: true, anchor: `#c-${entryId}`, reactions: some }))));
      const keys = fetcher.mock.calls.map(([options]) => options?.key);
      expect(keys.filter(key => key?.startsWith("vote-"))).toEqual(["vote-5", "vote-5", "vote-6"]);
      expect(keys.filter(key => key?.startsWith("stance-"))).toEqual(["stance-12", "stance-12", "stance-12"]);
      for (const guard of guards) expect(guard).not.toHaveBeenCalled();
    } finally {
      fetcher.mockClear();
      guards.forEach(guard => guard.mockReset());
    }
  });
});

describe("pickReactions: which Insightful state a button shows", () => {
  const response = (total: number, at: string) => ({ at, reactions: { insightful: { total, langs: 1 }, mine: true } });
  const loader: ReactionsView = { insightful: { total: 1, langs: 1 }, mine: false };

  it("shows the loader's values when there is no response of the button's own", () => {
    expect(pickReactions(null, loader, "2026-10-05T00:00:00Z")).toBe(loader);
    expect(pickReactions(null, loader)).toBe(loader);
  });

  it("shows the response when the page did not read its data after it (the response is newer), and the loader's values when it did", () => {
    const latest = response(2, "2026-10-05T00:00:10Z");
    expect(pickReactions(latest, loader, "2026-10-05T00:00:05Z")).toBe(latest.reactions);
    // the page reloaded after the press (a reply was sent, a navigation): its values include the press and what others did meanwhile
    expect(pickReactions(latest, loader, "2026-10-05T00:00:30Z")).toBe(loader);
    // a page that never reloads after a press (the lists): the response stands
    expect(pickReactions(latest, loader)).toBe(latest.reactions);
  });
});

describe("the reasons panel", () => {
  const reason = (id: number, lang: "ja" | "en" | "fr", handle: string, over: Partial<ReasonView> = {}): ReasonView => ({
    id,
    lang,
    authorHandle: handle,
    excerpt: { text: `reason ${id}`, lang, truncated: false, translation: null, pending: false },
    reactions: { insightful: { total: 0, langs: 0 }, mine: false },
    own: false,
    location: `/t/12?page=2#c-${id}`,
    reviewHref: null,
    ...over,
  });
  const panel = (reasons: Record<"agree" | "disagree" | "neither", ReasonView[]>, langParam: string | null = null) =>
    render(createElement(ReasonsPanel, { questionId: 12, reasons, langParam, readingLang: "en", loadedAt: "2026-10-05T00:00:00.000Z" }));

  it("has the three positions in the fixed order agree, disagree, neither, with 'Write a reason' (that opens the reply form with the mark chosen) for a position without a reply", async () => {
    const out = await panel({ agree: [reason(1, "ja", "a")], disagree: [], neither: [] });
    const headings = [...out.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]);
    expect(headings).toEqual([m.stance_tag_agree(), m.stance_tag_disagree(), m.stance_tag_neither()].map(messageMarkup));
    expect(out).toContain('href="/t/12?write=disagree#reply"');
    expect(out).toContain('href="/t/12?write=neither#reply"');
    expect(out).not.toContain("write=agree");
    expect((out.match(new RegExp(escapeRegex(messageMarkup(m.reasons_write())), "g")) ?? []).length).toBe(2);
    // the language of the page is kept in these links
    expect(await panel({ agree: [reason(1, "ja", "a")], disagree: [], neither: [] }, "en")).toContain('href="/t/12?lang=en&amp;write=disagree#reply"');
    setTestLocale("ja");
    expect(await panel({ agree: [], disagree: [], neither: [] })).toContain(messageMarkup(m.reasons_write()));
  });

  it("replaces an empty daily selection with one reply entry point, preserving the requested language", async () => {
    const out = await panel({ agree: [], disagree: [], neither: [] }, "en");
    expect(out).toContain(messageMarkup(m.reasons_empty_help()));
    expect(out).toContain('href="/t/12?lang=en#reply"');
    expect(out).not.toContain("data-position=");
    expect(out).not.toContain(messageMarkup(m.reasons_rule()));
    expect(out.match(new RegExp(escapeRegex(messageMarkup(m.reasons_write())), "g"))).toHaveLength(1);
    const reader = await render(createElement(ReasonsPanel, { questionId: 12, reasons: { agree: [], disagree: [], neither: [] }, langParam: null, readingLang: "en", reader: true }));
    expect(reader).toContain(messageMarkup(m.reasons_empty_help()));
    expect(reader).not.toContain("<a ");
  });

  it.each(["agree", "disagree", "neither"] as const)("keeps all three columns when only %s has a picked reason and folds the selection explanation", async (position) => {
    const out = await panel({ agree: [], disagree: [], neither: [], [position]: [reason(1, "en", "writer")] });
    expect(out.match(/data-position=/g)).toHaveLength(3);
    expect(out).not.toContain(messageMarkup(m.reasons_empty_help()));
    expect(out).toMatch(new RegExp(`<details\\b(?![^>]*\\bopen)[^>]*class="more-info[^"]*"[^>]*><summary[^>]*>${escapeRegex(messageMarkup(m.reasons_rule_summary()))}</summary><span class="more-info-body"><span[^>]*>${escapeRegex(messageMarkup(m.reasons_rule()))}</span></span></details>`));
  });

  it("shows each reply with its writer and the language it was written in, as a plain-text excerpt, and its own Insightful button", async () => {
    const out = await panel({
      agree: [reason(1, "ja", "hana"), reason(2, "fr", "marie", { reactions: { insightful: { total: 2, langs: 2 }, mine: true }, reviewHref: "/t/12?review=2#stance" })],
      disagree: [reason(3, "en", "john", { own: true })],
      neither: [],
    });
    for (const [handle, lang] of [["hana", "ja"], ["marie", "fr"]] as const) {
      const row = [...out.matchAll(/<div\b[^>]*>([\s\S]*?)<\/div>/g)].find(match => match[1].includes(`href="/u/${handle}"`))?.[1];
      expect(row).toBeDefined();
      expect(row).toContain(messageMarkup(m.reading_lang_original({ name: languageLabel(lang) })));
    }
    expect(out).toContain('<p dir="auto" lang="ja" class="break-words">reason 1</p>');
    // A complete excerpt has no read-more control and no link into the thread.
    expect(out).not.toContain(messageMarkup(m.reasons_read_more()));
    expect(out).not.toContain('href="/t/12?page=2#c-');
    // an Insightful button on the replies of other writers only; 'Reconsider my stance' on the one that is pressed and has a link
    expect((out.match(new RegExp(`>${escapeRegex(messageMarkup(m.insightful_give()))}</button>`, "g")) ?? []).length).toBe(2);
    expect(out).toContain(`>${messageMarkup(m.insightful_count_short({ total: 2, langs: 2 }))}</span>`);
    expect(out.match(new RegExp(escapeRegex(messageMarkup(m.insightful_review())), "g"))).toHaveLength(1);
    // the replies are not given the id of the same reply in the thread list (an id is used once on a page), and the buttons come back to the panel
    expect(out).toContain('id="reason-1"');
    expect(out).not.toContain('id="c-1"');
    expect(out).toContain('name="returnTo" value="/t/12#reason-1"');
  });

  it("shows the excerpt as text, never as the reply's HTML (no footnote ids, no clipped content to focus), and 'Read more' only when the excerpt is shorter than the reply, named after the writer", async () => {
    const out = await panel({
      agree: [reason(1, "ja", "hana", { excerpt: { text: "first part of a long reason…", lang: "ja", truncated: true, translation: null, pending: false } }), reason(2, "fr", "marie")],
      disagree: [],
      neither: [],
    });
    expect(out).not.toMatch(/fn-|footnote|<sup|<h1|<h2 id="fn/);
    // Exactly one read-more link, on the truncated excerpt, with its visible label and writer-specific accessible name.
    expect(out).toContain(`>${messageMarkup(m.reasons_read_more())}</a>`);
    expect(out).toMatch(new RegExp(`<a aria-label="${escapeRegex(messageMarkup(m.reasons_read_more_aria({ handle: "hana" })))}" class="underline" href="/t/12\\?page=2#c-1"[^>]*>${escapeRegex(messageMarkup(m.reasons_read_more()))}</a>`));
    expect(out).not.toContain(`aria-label="${messageMarkup(m.reasons_read_more_aria({ handle: "marie" }))}"`);
    expect(out.match(/<a [^>]*href="\/t\/12\?page=2#c-/g)).toHaveLength(1);
    setTestLocale("ja");
    const ja = await panel({ agree: [reason(1, "ja", "hana", { excerpt: { text: "長い理由の最初…", lang: "ja", truncated: true, translation: null, pending: false } })], disagree: [], neither: [] });
    expect(ja).toContain(`aria-label="${messageMarkup(m.reasons_read_more_aria({ handle: "hana" }))}"`);
    expect(ja).toMatch(new RegExp(`>${escapeRegex(messageMarkup(m.reasons_read_more()))}</a>`));
  });

  it("labels an excerpt that is a translation, and says when the translation is still pending", async () => {
    const translated = reason(1, "ja", "hana", { excerpt: { text: "A reason", lang: "en", truncated: false, translation: { kind: "primary", engine: "gemini", model: "m", fallback: false, stale: false }, pending: false } });
    const pending = reason(2, "ja", "ken", { excerpt: { text: "原文", lang: "ja", truncated: false, translation: null, pending: true } });
    const out = await panel({ agree: [translated, pending], disagree: [], neither: [] });
    expect(out).toContain('<p dir="auto" lang="en" class="break-words">A reason</p>');
    expect(out).toContain(messageMarkup(m.label_from_lang_machine({ lang: m.language_name_ja() })));
    expect(out).toContain(messageMarkup(m.label_pending()));
    const translatedRow = out.split('id="reason-1"')[1].split("</li>")[0];
    expect(translatedRow).not.toContain(messageMarkup(m.reading_lang_original({ name: languageLabel("ja") })));
    expect(out).not.toContain(messageMarkup(m.original_lang({ lang: languageLabel("ja") })));
  });

  it("names the original language of translated reasons in the reader's language", async () => {
    for (const locale of ["en", "ja"] as const) {
      setTestLocale(locale);
      for (const kind of ["primary", "human"] as const) {
        const translated = reason(1, "fr", "writer", { excerpt: { text: "Translated reason", lang: locale, truncated: false, translation: { kind, engine: "gemini", model: null, fallback: false, stale: false }, pending: false } });
        const out = await panel({ agree: [translated], disagree: [], neither: [] }, locale);
        const row = out.split('id="reason-1"')[1].split("</li>")[0];
        const label = kind === "human" ? m.label_from_lang_human : m.label_from_lang_machine;
        expect(row).toContain(messageMarkup(label({ lang: m.language_name_fr() })));
      }
    }
  });

  it("omits the redundant language label only for originals in the current reading language", async () => {
    const reasons = { agree: [reason(1, "ja", "writer")], disagree: [], neither: [] };
    const ownLanguage = await render(createElement(ReasonsPanel, { questionId: 12, reasons, langParam: null, readingLang: "ja" }));
    expect(ownLanguage).toContain("reason 1");
    expect(ownLanguage).not.toContain(messageMarkup(m.reading_lang_original({ name: languageLabel("ja") })));
    const otherLanguage = await render(createElement(ReasonsPanel, { questionId: 12, reasons, langParam: null, readingLang: "en" }));
    expect(otherLanguage).toContain(messageMarkup(m.reading_lang_original({ name: languageLabel("ja") })));
  });

  it("shows no writer's home area, no language count and no stance of any reader", async () => {
    const out = await panel({ agree: [reason(1, "ja", "hana")], disagree: [], neither: [] });
    expect(out).not.toMatch(/home|所属|言語圏|area/i);
    expect(out).not.toMatch(/\d+ languages?/);
  });
});

describe("the one-time ?review= mark of 'Reconsider my stance' is not carried by other links of the page", () => {
  it("keeps ?lang= but not ?review= in the links of the replies filter and of the pagination", async () => {
    const url = "/t/12?review=5&lang=en&page=2";
    const filter = await render(createElement(RepliesFilter, { current: null }), url);
    expect(filter).toContain("lang=en");
    expect(filter).not.toContain("review");
    const pages = await render(createElement(Pagination, { page: 2, hasNext: true, anchor: "#replies" }), url);
    expect(pages).toContain('href="/t/12?lang=en#replies"');
    expect(pages).toContain('href="/t/12?lang=en&amp;page=3#replies"');
    expect(pages).not.toContain("review");
  });
});
