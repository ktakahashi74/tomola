import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, useLoaderData, type StaticHandlerContext } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { PRINCIPLES_LANGS } from "~/lib/principles-languages";
import { parsePrinciples, principlesFor, principlesOpening, principlesStatus } from "~/lib/principles.server";
import { expectedPrinciplesStatus, readPrinciplesSource } from "./helpers/principles-source";
import { withShellLabels } from "./helpers/render-in-router";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("~/content/principles/en.md?raw");
  vi.resetModules();
});

const callMd = async (path: string) => (await (await import("~/routes/principles-md")).loader({ request: new Request(`http://localhost:5173${path}`), params: {}, context: {} } as never)) as Response;
async function renderPage(path: string) {
  const route = await import("~/routes/principles");
  const Component = () => createElement(route.default as never, { loaderData: useLoaderData() });
  const routes = withShellLabels([{ id: "principles", path: "/principles", Component, loader: route.loader as never }]);
  const context = (await createStaticHandler(routes).query(new Request(`http://localhost:5173${path}`))) as StaticHandlerContext;
  const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context, hydrate: false }));
  return { html, data: context.loaderData.principles };
}

const fixture = (intro: string) => `# Fixture title

${intro}

${Array.from({ length: 7 }, (_, i) => `## ${i + 1}. Section ${i + 1}

- **Item.** Fixture body.`).join("\n\n")}
`;

it.each([
  ["Unverified machine translation", "unverified"],
  [" \tUnverified machine translation \t", "unverified"],
  ["uNvErIfIeD MACHINE Translation", "unverified"],
  ["Fixture introduction.", "human_checked"],
  ["Unverified machine translation is a label.", "human_checked"],
  ["Fixture introduction.\n\nUnverified machine translation", "human_checked"],
  ["", "human_checked"],
] as const)("derives %s from the first nonblank line after the title", (intro, status) => {
  for (const newline of ["\n", "\r\n"]) {
    const raw = fixture(intro).replaceAll("\n", newline);
    expect(principlesStatus(parsePrinciples(raw, "en"))).toBe(status);
  }
});

it("keeps Japanese original and rejects its translation marker during loading", () => {
  expect(principlesStatus(parsePrinciples(fixture("Original introduction."), "ja"))).toBe("original");
  for (const intro of ["Unverified machine translation", " \tUNVERIFIED MACHINE TRANSLATION "])
    for (const newline of ["\n", "\r\n"])
      expect(() => parsePrinciples(fixture(intro).replaceAll("\n", newline), "ja")).toThrow(/original cannot have/);
});

it("the page, Markdown twin and both machine guides share the text-derived states of every edition", async () => {
  const { llmsTxt } = await import("~/lib/api/guides.server");
  const { openApiDocument } = await import("~/lib/api/openapi.server");
  const guides = [llmsTxt(), JSON.stringify(openApiDocument())];
  for (const lang of PRINCIPLES_LANGS) {
    const status = principlesFor(lang).status;
    expect(status).toBe(expectedPrinciplesStatus(lang));
    const { html, data } = await renderPage(`/principles?lang=${lang}`);
    expect(data).toMatchObject({ shown: lang, status });
    expect(html).not.toContain('role="note"');
    // Language spans can divide the visible marker without changing its text or state.
    const visibleText = html.replace(/<[^>]+>/g, "");
    if (status === "unverified") expect(visibleText).toContain("Unverified machine translation");
    else expect(visibleText).not.toContain("Unverified machine translation");
    for (const comment of readPrinciplesSource(lang).comments)
      for (const output of [html, await (await callMd(`/principles.md?lang=${lang}`)).text(), ...guides]) expect(output, lang).not.toContain(comment);
    if (lang !== "ja") expect(html).toContain(">Read the original (Japanese)<");
    expect(await (await callMd(`/principles.md?lang=${lang}`)).text()).toContain(`\nstatus: ${status}\n`);
    for (const guide of guides) expect(guide).toContain(`${lang}: ${status}`);
  }
});

it.each(["unverified", "human_checked"] as const)("one edition's fixture changes its public status to %s without affecting the others", async status => {
  const raw = `<!-- hidden fixture note\ncontinued on a second line -->\n<!-- second hidden note -->\n${fixture(status === "unverified" ? "Unverified machine translation" : "Fixture introduction.")}`;
  vi.resetModules();
  vi.doMock("~/content/principles/en.md?raw", () => ({ default: raw }));
  const { principlesFor: changed } = await import("~/lib/principles.server");
  expect(changed("en").status).toBe(status);
  const { html, data } = await renderPage("/principles?lang=en");
  expect(data).toMatchObject({ status });
  expect(html.includes("Unverified machine translation")).toBe(status === "unverified");
  expect(html).toContain('href="/principles?lang=ja"');
  expect(html).not.toContain('role="note"');
  const markdown = await (await callMd("/principles.md?lang=en")).text();
  expect(markdown).toContain(`\nstatus: ${status}\n`);
  const { llmsTxt } = await import("~/lib/api/guides.server");
  const { openApiDocument } = await import("~/lib/api/openapi.server");
  const guides = [llmsTxt(), JSON.stringify(openApiDocument())];
  for (const output of [html, markdown, ...guides]) {
    expect(output).not.toContain("hidden fixture note");
    expect(output).not.toContain("continued on a second line");
    expect(output).not.toContain("second hidden note");
  }
  for (const guide of guides) {
    expect(guide).toContain(`en: ${status}`);
    for (const other of PRINCIPLES_LANGS.filter(lang => lang !== "en")) expect(guide).toContain(`${other}: ${expectedPrinciplesStatus(other)}`);
  }
  const other = await renderPage("/principles?lang=fr");
  expect(other.data).toMatchObject({ status: expectedPrinciplesStatus("fr") });
  expect(await (await callMd("/principles.md?lang=fr")).text()).toContain(`\nstatus: ${expectedPrinciplesStatus("fr")}\n`);
});

it("offers the first sentence of each edition for the signup screen, as one sentence, and says when it is an unchecked machine translation", () => {
  for (const lang of PRINCIPLES_LANGS) {
    const { text, ai } = principlesOpening(lang);
    expect(text.length, lang).toBeGreaterThan(5);
    expect(text, lang).not.toMatch(/unverified machine translation/i);
    expect(text, lang).not.toMatch(/^#|<!--/);
    expect(ai, lang).toBe(principlesStatus(principlesFor(lang).document) === "unverified");
  }
  // The sentence is the start of the first paragraph of the edition itself, whatever it says.
  for (const lang of ["en", "ja"] as const) {
    const first = readPrinciplesSource(lang).markdown.split(/\r?\n/).slice(1).find(line => line.trim() !== "")!;
    const { text } = principlesOpening(lang);
    expect(first.replace(/[*_`]/g, "").startsWith(text), lang).toBe(true);
    expect(text, lang).not.toContain("\n");
  }
});

it.each(["ja", "en", "fr"] as const)("uses configured %s information at both insertion points and in the HTML and Markdown routes", async lang => {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "principles-operator-"));
  fs.cpSync("tests/fixtures/operator", directory, { recursive: true });
  const locale = lang === "fr" ? "en" : lang;
  const rules = `Rules ${locale}: [ready](/terms), $&.`;
  const contact = `- Objections ${locale}: [contact](mailto:review@community.invalid).`;
  fs.writeFileSync(path.join(directory, "principles-rules-status", `${locale}.md`), rules);
  fs.writeFileSync(path.join(directory, "principles-objections-contact", `${locale}.md`), contact);
  vi.stubEnv("TOMOLA_OPERATOR_DIR", directory);
  vi.resetModules();
  try {
    const { principlesFor: configured } = await import("~/lib/principles.server");
    const document = configured(lang).document;
    expect(document.sections[5].markdown).toContain(rules);
    expect(document.sections[6].markdown).toContain(contact);
    const markdown = await (await callMd(`/principles.md?lang=${lang}`)).text();
    expect(markdown).toContain(rules);
    expect(markdown).toContain(contact);
    const { html } = await renderPage(`/principles?lang=${lang}`);
    expect(html.replace(/<[^>]+>/g, "").replace(/&amp;|&#x26;/g, "&")).toContain(`Rules ${locale}: ready, $&.`);
    expect(html).toContain('href="mailto:review@community.invalid"');
    expect(html).not.toContain("{{principles-");
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
