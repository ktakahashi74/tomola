import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ChatNushiBody } from "~/components/chat-message";
import { NushiAnswer, NushiCallStatus, type NushiAnswerView } from "~/components/nushi";
import { NushiSources } from "~/components/nushi-sources";
import { chatParts } from "~/lib/village-chat";
import { m } from "~/paraglide/messages.js";
import { setTestLocale } from "./stubs/paraglide-runtime";

const control = vi.hoisted(() => ({ origin: "https://example.test" as string | null, measure: false, effects: [] as Array<() => unknown>, setLong: vi.fn() }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useEffect: (effect: import("react").EffectCallback, deps: unknown[]) => control.measure ? control.effects.push(effect) : react.useEffect(effect, deps),
    useRef: (value: unknown) => control.measure ? { current: { scrollHeight: 400 } } : react.useRef(value),
    useState: (value: unknown) => control.measure ? [value, control.setLong] : react.useState(value),
  };
});
afterEach(() => { setTestLocale("en"); control.origin = "https://example.test"; control.measure = false; control.effects = []; control.setLong.mockClear(); vi.unstubAllGlobals(); });

function tags(html: string, tag: string) {
  const nodes: Array<{ attrs: Record<string, string>; text: string; html: string }> = [];
  let depth = 0, start = 0, attrs = "";
  for (const match of html.matchAll(new RegExp(`<(/?)${tag}\\b([^>]*)>`, "g"))) {
    if (!match[1]) {
      if (depth++ === 0) { start = match.index + match[0].length; attrs = match[2]; }
    } else if (--depth === 0) {
      const content = html.slice(start, match.index);
      nodes.push({ attrs: Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1].toLowerCase(), attribute[2]])), text: content.replace(/<[^>]*>/g, ""), html: content });
    }
  }
  return nodes;
}

function chatAnswer(reading = "The post asks for public review.", date = "2026-04-02") {
  const href = "https://example.test/t/7?orig=7#p-7:~:text=An%20orchard";
  const head = `${reading} [1]`;
  const block = `[1] @@writer · ${date}\nOriginal passage\n\nWith context.\n訳の箇所。\n${href}`;
  const body = `${head}\n\n${block}\n\n${m.nushi_scope({ count: 1, from: date, to: date })}`;
  const start = head.length + 2;
  return { href, body, sources: { citationRanges: [[start, start + block.length] as [number, number]], scopeStart: start + block.length + 2, bodyLength: body.length, readingChars: reading.length } };
}

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
vi.mock("react-router", async original => ({ ...await original<typeof import("react-router")>(), useRouteLoaderData: () => ({ siteOrigin: control.origin }) }));

function postAnswer(): Extract<NushiAnswerView, { hidden: false }> {
  return {
    id: 1, requestId: "request", entryId: 1, threadId: 7, hidden: false,
    answer: { status: "answered", readings: [{ text: "The orchard needs review.", citations: [] }], citations: [] },
    lang: "en", langCode: null, originalLang: "en", translated: false, translationEngine: "fake", translationModel: "fake",
    scope: { posts: 3, from: "2026-04-01", to: "2026-04-02", truncated: false }, engine: "fake", model: "fake", promptVersion: "nushi-v8", date: "2026-04-02T12:00:00Z",
    caller: "reader", personal: false, villageId: "village", villageSlug: "orchard", labels: [],
  };
}

it.each(["en", "ja"] as const)("keeps the AI label, caller, date and consulted scope visible in %s", locale => {
  setTestLocale(locale);
  const answer = postAnswer();
  answer.scope.truncated = true;
  const html = renderToStaticMarkup(createElement(NushiAnswer, { answer }));
  const header = tags(html, "header")[0];
  const line = tags(header.html, "p");
  expect(line).toHaveLength(1);
  expect(line[0].text).toBe(`${m.nushi_name()} · ${m.nushi_answer_label({ handle: answer.caller! })} · ${answer.date.slice(0, 10)}`);
  expect(tags(line[0].html, "a").map(node => node.attrs.href)).toEqual(["/ai-use#nushi", `/nushi/${answer.id}`]);
  expect(tags(line[0].html, "time")[0].attrs.datetime).toBe(answer.date);
  const scope = tags(html, "p").find(node => "data-nushi-scope" in node.attrs)!;
  expect(scope.text).toBe(`${m.nushi_answer_scope({ count: answer.scope.posts, from: answer.scope.from!, to: answer.scope.to! })} · ${m.nushi_truncated()}`);
  expect(tags(html, "details").every(node => !node.html.includes("data-nushi-scope"))).toBe(true);
  const about = tags(html, "details").find(node => "data-nushi-about" in node.attrs)!;
  expect(about.attrs).not.toHaveProperty("open");
  expect(tags(about.html, "summary")[0].text).toBe(m.nushi_answer_about());
  expect(tags(about.html, "a").map(node => ({ href: node.attrs.href, text: node.text }))).toEqual([
    { href: "/ai-use#nushi", text: `${answer.model} · ${answer.promptVersion}` },
    { href: "/principles#s6", text: m.ai_use_objections_link() },
    { href: "/search?village=orchard", text: m.nushi_search() },
  ]);
});

it.each([false, true])("keeps answer details separate from the ordinary actions for member=%s", member => {
  const answer = postAnswer(), back = "/t/7";
  const html = renderToStaticMarkup(createElement(NushiAnswer, { answer, member, back }));
  const about = tags(html, "details").find(node => "data-nushi-about" in node.attrs)!;
  expect(tags(about.html, "form")).toHaveLength(member ? 1 : 0);
  expect(about.html.includes('name="kind" value="error"')).toBe(member);
  if (member) {
    const error = tags(about.html, "details")[0];
    expect(tags(error.html, "summary")[0].text).toBe(m.nushi_report_error());
    expect(error.html).toContain('name="consent" value="1"');
    const actions = tags(html, "div").at(-1)!;
    expect(tags(actions.html, "a").map(node => ({ href: node.attrs.href, text: node.text }))).toEqual([{ href: `/t/${answer.threadId}?nushi_reply=${answer.id}#reply`, text: m.reply_to_button() }]);
    expect(tags(actions.html, "summary").map(node => node.text)).toEqual([m.flag_summary()]);
    expect(actions.html).toContain('name="kind" value="moderation"');
    expect(actions.text).not.toContain(m.nushi_report_error());
    for (const form of tags(html, "form")) {
      expect(form.attrs).toMatchObject({ method: "post", action: "/nushi/action" });
      expect(form.html).toContain(`name="answerId" value="${answer.id}"`);
      expect(form.html).toContain(`name="returnTo" value="${back}"`);
    }
  } else {
    expect(tags(html, "form")).toHaveLength(0);
    expect(html).not.toContain(m.reply_to_button());
    expect(html).not.toContain(m.flag_summary());
    expect(html).not.toContain(m.nushi_report_error());
  }
});

it.each(["pending", "processing"])("keeps animated punctuation out of the %s announcement", state => {
  const html = renderToStaticMarkup(createElement(NushiCallStatus, { state, failure: null }));
  const status = tags(html, "p").find(node => node.attrs.role === "status")!;
  expect(status).toBeDefined();
  expect(tags(status.html, "span").some(node => node.attrs["aria-hidden"] === "true")).toBe(true);
  expect(status.html.replace(/<span aria-hidden="true"[\s\S]*<\/span>/, "").replace(/<[^>]*>/g, "")).toBe(m.nushi_pending());
});

it("shortens only same-origin AI source labels while preserving exact destinations", () => {
  const internal = "https://example.test/t/7?orig=7#material:~:text=An%20orchard";
  const external = "https://elsewhere.test/t/7#material:~:text=An%20orchard";
  const spoof = "https://example.test.elsewhere.test/t/7";
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(`${internal}\n${external}\n${spoof}`) }));
  expect(html).toContain(`href="${internal}"`);
  expect(html).toContain(`>${m.nushi_open_post()}</a>`);
  expect(html).toContain(`>${external}</a>`);
  expect(html).toContain(`>${spoof}</a>`);
  expect(html).not.toContain(`>${internal}</a>`);
});

it("preserves URLs in readings and original and translated quotations while shortening the source line", () => {
  const url = "https://example.test/t/7#p-7:~:text=An%20orchard";
  const body = `Read more at ${url} [1]\n\n[1] @author\nOriginal quote with ${url} in its prose.\nTranslated quote with ${url} in its prose.\n${url}`;
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(body) }));
  expect(html.split(`>${url}</a>`)).toHaveLength(4);
  expect(html.split(`>${m.nushi_open_post()}</a>`)).toHaveLength(2);
  expect(html.split(`href="${url}"`)).toHaveLength(5);
});

it.each(["/v/orchard", "/settings/profile", "/t/word", "/t/7/extra"])("preserves a standalone URL to %s", path => {
  const url = `https://example.test${path}`;
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(url) }));
  expect(html).toContain(`>${url}</a>`);
  expect(html).not.toContain(m.nushi_open_post());
});

it.each([
  ["en", ["4/2", "4/3", "4/4"]], ["ja", ["4/2", "4/3", "4/4"]],
  ["fr", ["02/04", "03/04", "04/04"]], ["ko", ["4. 2.", "4. 3.", "4. 4."]],
  ["zh-Hans", ["4/2", "4/3", "4/4"]], ["zh-Hant", ["4/2", "4/3", "4/4"]],
] as const)("formats the source list for %s readers with visible separators and quotations closed", (locale, dates) => {
  setTestLocale(locale);
  const sources = [
    { author: "@a", date: "2026-04-02", href: "/t/1?orig=1#p-1", quote: "Original passage" },
    { author: "@c", date: "2026-04-03", href: "/t/3?orig=3#p-3", quote: "Another passage" },
    { author: "@d", date: "2026-04-04", href: "/t/4?orig=4#p-4", quote: "Third passage" },
  ];
  const html = renderToStaticMarkup(createElement(NushiSources, { sources }));
  const line = tags(html, "p").find(node => "data-nushi-sources" in node.attrs)!;
  const labels = sources.map((source, i) => `${source.author} ${dates[i]}`);
  expect(tags(line.html, "a").map(node => ({ href: node.attrs.href, text: node.text }))).toEqual(sources.map((source, i) => ({ href: source.href, text: labels[i] })));
  const separators = [...line.html.matchAll(/<\/a>(.*?)<a\b/gs)].map(match => match[1]);
  expect(separators).toHaveLength(sources.length - 1);
  for (const separator of separators) expect(separator).toMatch(/\S/u);
  expect(line.text.startsWith(m.nushi_sources() + (/^(ja|zh)/.test(locale) ? "" : " ") + "@a")).toBe(true);
  const quotes = tags(html, "details").find(node => "data-nushi-quotes" in node.attrs)!;
  expect(quotes.attrs).not.toHaveProperty("open");
  expect(tags(quotes.html, "summary")[0].text).toBe(m.nushi_quotes());
  expect(quotes.text).toContain("Original passage");
});

it.each([false, true])("links inline numbers and folds only quotations after translated=%s readings", translated => {
  const { href, body, sources } = chatAnswer();
  const shown = translated ? body.replace("The post asks for public review.", "公開の検討を求める投稿。") : body;
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(shown), sources }));
  const reference = tags(html, "a").find(node => "data-nushi-reference" in node.attrs)!;
  expect(reference.attrs.href).toBe(href);
  expect(reference.text).toBe("[1]");
  expect(reference.attrs["aria-label"]).toContain("@writer");
  expect(reference.attrs["aria-label"]).toContain(new Intl.DateTimeFormat("en", { month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date("2026-04-02T00:00:00Z")));
  const line = tags(html, "p").find(node => "data-nushi-sources" in node.attrs)!;
  expect(tags(line.html, "a")[0].attrs.href).toBe(href);
  expect(line.text).toContain("@writer");
  const quotes = tags(html, "details").find(node => "data-nushi-quotes" in node.attrs)!;
  expect(quotes.attrs).not.toHaveProperty("open");
  expect(quotes.text).toContain("Original passage\n\nWith context.\n訳の箇所。");
  expect(tags(html, "p").find(node => "data-nushi-scope" in node.attrs)?.text).toBe(m.nushi_scope({ count: 1, from: "2026-04-02", to: "2026-04-02" }));
  expect(tags(html, "details")).toHaveLength(1);
  expect(tags(quotes.html, "a").find(node => node.text === m.nushi_open_post())?.attrs.href).toBe(href);
});

it.each([false, true])("shows former membership beside the public source with left=%s before quotations open", left => {
  const answer: NushiAnswerView = {
    id: 1, requestId: "request", entryId: 1, threadId: 1, hidden: false,
    answer: { status: "answered", readings: [{ text: "@writer asks for review.", citations: [1] }], citations: [{
      sourceId: "e-7-body", kind: "post", field: "body", author: "@writer", original: { quote: "Original passage", lang: "en", href: "/t/7" },
    }] }, lang: "en", langCode: null, originalLang: "en", translated: false, translationEngine: "fake", translationModel: "fake",
    scope: { posts: 1, from: "2026-04-02", to: "2026-04-02", truncated: false }, engine: "fake", model: "fake", promptVersion: "nushi-v8", date: "2026-04-02",
    caller: "reader", personal: false, villageId: "village", villageSlug: "orchard",
    labels: [{ id: 7, author: "@writer", authorHref: "/u/writer", date: "2026-04-02", left }],
  };
  const html = renderToStaticMarkup(createElement(NushiAnswer, { answer }));
  const line = tags(html, "p").find(node => "data-nushi-sources" in node.attrs)!;
  expect(line.text).toContain("@writer");
  expect(line.text.includes(m.nushi_left())).toBe(left);
  expect(tags(line.html, "a").every(node => !node.text.includes(m.nushi_left()))).toBe(true);
  expect(tags(html, "details").find(node => "data-nushi-quotes" in node.attrs)!.attrs).not.toHaveProperty("open");
});

it.each(["en", "ja"] as const)("keeps former-membership notes outside unbroken source links in %s", locale => {
  setTestLocale(locale);
  const sources = [
    { author: "@" + "a".repeat(30), date: "2026-04-02", href: "/t/1", quote: "First passage", left: true },
    { author: "@writer", date: "2026-04-03", href: "/t/2", quote: "Second passage" },
  ];
  const html = renderToStaticMarkup(createElement(NushiSources, { sources }));
  const line = tags(html, "p").find(node => "data-nushi-sources" in node.attrs)!;
  expect(tags(line.html, "a").map(node => node.text)).toEqual([`${sources[0].author} 4/2`, "@writer 4/3"]);
  expect(line.html).toContain(`</a> (${m.nushi_left()})`);
  expect(line.text).not.toContain("。、");
  expect(line.attrs.class).not.toContain("whitespace-nowrap");
  expect(tags(line.html, "span").some(node => node.text.includes(m.nushi_left()) && node.attrs.class?.includes("whitespace-nowrap"))).toBe(false);
});

it.each([undefined, -1])("keeps every new chat control in the message tab order with tabIndex=%s", tabIndex => {
  const { body, sources } = chatAnswer("Reading. ".repeat(300));
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(body), sources, tabIndex }));
  for (const node of [...tags(html, "a"), ...tags(html, "summary")]) expect(node.attrs.tabindex).toBe(tabIndex === -1 ? "-1" : undefined);
});

it.each([2200, 2201])("folds chat readings at the public-answer threshold for %s characters", length => {
  const { body, sources } = chatAnswer("a".repeat(length));
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(body), sources }));
  expect(html.includes("data-nushi-readings")).toBe(length > 2200);
  if (length > 2200) expect(tags(html, "p")[0].attrs.dir).toBe("auto");
  expect(tags(html, "details").find(node => "data-nushi-quotes" in node.attrs)).toBeDefined();
});

it.each([false, true])("discloses truncated=%s beside the consulted scope", truncated => {
  const { body, sources } = chatAnswer();
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(body), sources, truncated }));
  const scope = tags(html, "p").find(node => "data-nushi-scope" in node.attrs)!;
  expect(scope.html.includes("data-nushi-truncated")).toBe(truncated);
  if (truncated) expect(scope.text).toContain(m.nushi_truncated());
});

it.each(["missing origin", "changed origin", "missing date"])("measures the legacy body after source parsing fails with %s", failure => {
  if (failure === "missing origin") control.origin = null;
  if (failure === "changed origin") control.origin = "https://new.example.test";
  const { body, sources } = chatAnswer("Long reading. ".repeat(100), failure === "missing date" ? "" : undefined);
  const observe = vi.fn(), disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe = observe; disconnect = disconnect; });
  vi.stubGlobal("getComputedStyle", () => ({ lineHeight: "20px" }));
  control.measure = true;
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(body), sources, tabIndex: -1 }));
  expect(html).not.toContain("data-nushi-sources");
  const cleanup = control.effects[0]() as () => void;
  expect(observe).toHaveBeenCalledOnce();
  expect(control.setLong).toHaveBeenCalledWith(true);
  cleanup();
  expect(disconnect).toHaveBeenCalledOnce();
  for (const node of tags(html, "a")) expect(node.attrs.tabindex).toBe("-1");
});

it.each([2200, 2201])("counts paragraph breaks and translated length at the %s-character fold boundary", length => {
  const reading = "a".repeat(1098) + "\n\n" + "b".repeat(1100);
  const { body, sources } = chatAnswer(reading);
  const shown = body.replace(reading, reading + "c".repeat(length - reading.length));
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(shown), sources }));
  expect(html.includes("data-nushi-readings")).toBe(length > 2200);
});
