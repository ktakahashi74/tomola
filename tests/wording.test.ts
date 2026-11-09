import { messageMarkup } from "./helpers/message-markup";
import { formatOperatorCopy, operatorCopy } from "~/lib/operator-settings";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, type StaticHandlerContext } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AI_ASSISTANCE } from "~/lib/ai-assistance";
import { aiTxt, helpAiMd, llmsTxt } from "~/lib/api/guides.server";
import { openApiDocument } from "~/lib/api/openapi.server";
import { LANGS } from "~/lib/languages";
import { drawHome, homeText, setupHomeWording } from "./helpers/home-wording";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { OperatorSettingsContext } from "~/lib/operator-context";
import { testOperator } from "./helpers/operator";

// Keep wording restrictions separate from the messages used to check screen behavior.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const messages = (lang: string) => JSON.parse(read(`messages/${lang}.json`)) as Record<string, string>;
const ALL_LANGS = ["en", ...LANGS.filter((l) => l !== "en")];

function filesUnder(dir: string, skip: (relative: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (skip(relative)) continue;
    if (entry.isDirectory()) out.push(...filesUnder(relative, skip));
    else out.push(relative);
  }
  return out;
}

const guides = () => ({ "/llms.txt": llmsTxt(), "/ai.txt": aiTxt(), "/help/ai.md": helpAiMd(), "/api/openapi.json": JSON.stringify(openApiDocument(), null, 2) });

const PHRASES_EN = ["never published until you approve", "AI assistance declared", "AI assistance (optional)", "declared by the author", "You cannot publish.", "The API never publishes."];
const PHRASES_JA = ["承認するまで公開されません", "AI支援の申告", "AIの支援（任意）"];
const homeKeys = /^(home_|card_|composer_|list_|rules_link$|nav_home$|field_title|order_)/;
const homeForbidden = /言語圏|language area|home area|匿名|anonym|大学|universit|agibook/i;
type WordingScope = "messages" | "japaneseMessages" | "app" | "guides" | "principles" | "homeMessages" | "homeRendered" | "japaneseOrder" | "englishOrder" | "messageKeys" | "englishMessages";

// Each row retains the original match and its original scope. Message scopes inspect
// only entries present in each file; translated files need not contain every key.
const forbiddenWording: { word: string | RegExp; scopes: WordingScope[] }[] = [
  { word: /agibook/i, scopes: ["messages", "app", "guides", "principles"] },
  ...PHRASES_EN.map(word => ({ word, scopes: ["messages"] as WordingScope[] })),
  ...PHRASES_JA.map(word => ({ word, scopes: ["japaneseMessages"] as WordingScope[] })),
  { word: "匿名化", scopes: ["messages", "principles"] },
  { word: /anonymi[sz]/i, scopes: ["messages", "principles"] },
  { word: /anonymous (data|records?)/i, scopes: ["messages"] },
  { word: /\banonymous\b/i, scopes: ["englishMessages"] },
  { word: homeForbidden, scopes: ["homeMessages", "homeRendered"] },
  { word: /人気|おすすめ|注目|ランキング|スコア/, scopes: ["japaneseOrder"] },
  { word: /popular|trending|recommended|ranking|score/i, scopes: ["englishOrder"] },
  { word: /^(field_ai|field_ai_auto|field_details|ai_label|draft_via_api_ai)$/m, scopes: ["messageKeys"] },
];

// Machine-readable guide phrase checks remain below, alongside their original
// assertions. The signup disclosure checks also retain their fixed wording.
describe("no agibook in anything a user or an AI reads", () => {
  it("not in the messages (screens, emails, notifications), the code and the content under app/, the guides, the OpenAPI document or the principles page", async () => {
    const sources: Record<WordingScope, [string, string][]> = {
      messages: [], japaneseMessages: [], app: [], guides: Object.entries(guides()),
      principles: [], homeMessages: [], homeRendered: [], japaneseOrder: [], englishOrder: [], messageKeys: [], englishMessages: [],
    };
    for (const lang of ALL_LANGS) {
      const table = messages(lang);
      // Retain whole-file checks (including keys) without assuming a complete table.
      sources.messages.push([lang, JSON.stringify(table)]);
      if (lang === "ja") sources.japaneseMessages.push([lang, JSON.stringify(table)]);
      for (const [key, value] of Object.entries(table)) {
        if (homeKeys.test(key)) sources.homeMessages.push([`${lang}.${key}`, value]);
        // The observation export note is the existing exception for this word.
        if (lang === "en" && key !== "observation_export_help") sources.englishMessages.push([key, value]);
      }
      sources.messageKeys.push([lang, Object.keys(table).join("\n")]);
      if (lang === "ja" || lang === "en") {
        sources[lang === "ja" ? "japaneseOrder" : "englishOrder"].push([lang,
          ["home_unified_rule_created", "home_unified_rule_activity", "home_unified_rule_insightful"].flatMap(key => key in table ? [table[key]] : []).join("")]);
      }
    }
    // app/paraglide is generated from the messages.
    sources.app = filesUnder("app", relative => relative === "app/paraglide").map(file => [file, read(file)]);
    const { principlesFor } = await import("~/lib/principles.server");
    sources.principles = LANGS.map(lang => [`/principles.md?lang=${lang}`, principlesFor(lang).document.markdown]);
    const h = await setupHomeWording();
    try {
      for (const locale of ["en", "ja"] as const) {
        sources.homeRendered.push([`home:${locale}`, homeText(await drawHome(h, locale))]);
      }
      sources.homeRendered.push(["home:activity:en", await drawHome(h, "en", "hana", undefined, "/?order=activity")]);
      for (const { word, scopes } of forbiddenWording) {
        for (const scope of scopes) for (const [name, text] of sources[scope]) {
          const found = typeof word === "string" ? text.includes(word) : word.test(text);
          expect(found, `${scope}:${name}: ${word}`).toBe(false);
        }
      }
    } finally {
      h.restore();
      setTestLocale("en");
      vi.unstubAllEnvs();
    }
  });
});

describe("AI use is not written as an exception", () => {

  it("the screens and the guides say that posts under a member's name are only those the member has confirmed", () => {
    expect(helpAiMd()).toContain("Posts under your name are only those you have confirmed");
    expect(llmsTxt()).toContain("Publishing happens only in the member's browser");
    expect(llmsTxt()).toContain("If the member has turned on passkey confirmation in settings");
    expect(JSON.stringify(openApiDocument())).toContain("only those the member has confirmed");
  });

  it("the guides say that ai_assistance is optional and omitted when absent", () => {
    for (const text of [llmsTxt(), helpAiMd()]) expect(text).toContain("optional; omitted when absent");
    expect(JSON.stringify(openApiDocument())).toContain("if it is not written, nothing is recorded");
  });
});

describe("the mechanisms and the machine-readable meanings did not change", () => {
  it("the four ai_assistance values and the two via values are the same", () => {
    expect([...AI_ASSISTANCE]).toEqual(["none", "polish", "draft", "coauthor"]);
    expect(read("app/lib/db/schema.ts")).toContain('const ENTRY_VIAS = ["web", "api"] as const;');
  });

  it("endorsed keeps its meaning in the guide: publishing is the author's acceptance of responsibility", () => {
    expect(llmsTxt()).toContain("endorsed: true (publishing is the author's acceptance of responsibility)");
  });

  it("the API still only creates drafts, and the member publishes them in the browser (the guides and the OpenAPI document say so)", () => {
    expect(llmsTxt()).toContain("Create a draft with");
    expect(llmsTxt()).toContain("publishes it in the browser");
    expect(helpAiMd()).toContain("the API creates a draft, and you read it and publish it in the browser");
    const doc = openApiDocument() as { paths: Record<string, { post?: { summary?: string } }> };
    expect(doc.paths["/api/drafts"].post?.summary).toContain("the member publishes it in the browser");
  });
});

describe("the disclosure of aggregated operator metrics", () => {

  it("is shown on /settings/stances in both languages, with the old sentence that said the operator's screen does not show a stance gone", async () => {
    const h: RouteHarness = await setupRouteHarness();
    try {
      await h.signIn("hana", { homeArea: "ja" });
      const route = await import("~/routes/settings-stances");
      const loaderData = await route.loader(h.args(h.request("/settings/stances", { as: "hana" })));
      const routes = [{ path: "/", Component: () => createElement(route.default as never, { loaderData, actionData: undefined }) }];
      const handler = createStaticHandler(routes);
      const context = (await handler.query(new Request("http://localhost/"))) as StaticHandlerContext;
      const draw = () => renderToStaticMarkup(createElement(OperatorSettingsContext.Provider, { value: testOperator },
        createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context })));
      const html = draw();
      expect(html).toContain(messageMarkup(operatorCopy(testOperator, "en").stanceDisclosure));
      expect(html).toContain(messageMarkup(formatOperatorCopy(messages("en").stance_consent_text, { lookupPolicy: operatorCopy(testOperator, "en").stanceConsent })));
      const { setTestLocale } = await import("./stubs/paraglide-runtime");
      setTestLocale("ja");
      const ja = draw();
      setTestLocale("en");
      expect(ja).toContain(messageMarkup(operatorCopy(testOperator, "ja").stanceDisclosure));
      expect(ja).toContain(messageMarkup(formatOperatorCopy(messages("ja").stance_consent_text, { lookupPolicy: operatorCopy(testOperator, "ja").stanceConsent })));
    } finally {
      h.restore();
    }
  });
});

describe("the words for anonymising records are not used", () => {
  it("in the English messages, the only text that says anonymous is the operator's note that the observation export is pseudonymous, not anonymous; the guides never do (stances are counted without names)", () => {
    for (const [name, text] of Object.entries(guides())) expect(text, name).not.toMatch(/anonym/i);
    expect(llmsTxt()).toContain("The choice is counted without names");
    expect(llmsTxt()).toContain("the three-way choice, counted without names, that a question may collect");
  });

  it("not in the guides or the principles page either", async () => {
    const texts = Object.values(guides());
    for (const text of texts) {
      expect(text).not.toContain("匿名化");
      expect(text).not.toMatch(/anonymi[sz]/i);
    }
  });
});
