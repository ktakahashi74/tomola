import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AiUse, { headers, loader, meta } from "~/routes/ai-use";
import { loader as markdownLoader } from "~/routes/ai-use-md";
import { aiUseMarkdown, aiUsePage } from "~/lib/ai-use-page.server";
import { resolveEngines, resolveEmbeddingEngine, sourceLanguageConfig } from "~/lib/llm/config.server";
import { createFigureReader } from "~/lib/figure-reading.server";
import { moderationAiConfig } from "~/lib/moderation-ai-config.server";
import { publicOperatorSettings, type AiUseSettings } from "~/lib/operator-config.server";
import { m } from "~/paraglide/messages.js";
import { testOperator } from "./helpers/operator";
import { renderInRouter } from "./helpers/render-in-router";
import { parseBlocks } from "./helpers/md";
import { setTestLocale } from "./stubs/paraglide-runtime";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); setTestLocale("en"); });

const fake = { TRANSLATION_PRIMARY: "fake", EMBEDDING_ENGINE: "fake" };
const secrets = {
  GEMINI_API_KEY: "key-sentinel-gemini-omega", ANTHROPIC_API_KEY: "key-sentinel-anthropic-omega",
  DATABASE_URL: "postgres://fictional:password-sentinel-omega@127.0.0.1:9198/private-database",
  SMTP_URL: "smtp://fictional:mail-password-sentinel-omega@127.0.0.1:9197",
  GEMINI_BASE_URL: "http://127.0.0.1:9199/private-ai-endpoint",
  SERVICE_CREDENTIALS: "credentials-sentinel-omega", LLM_PRICE_GEMINI_DISCLOSURE_PRIMARY: "177.777,222.222",
};
const settings = (): AiUseSettings => structuredClone(testOperator.aiUse);
const row = (page: ReturnType<typeof aiUsePage>, purpose: string) => page.rows.find(value => value.purpose === purpose)!;
const md = (path = "/ai-use.md", method = "GET") => markdownLoader({ request: new Request(`http://localhost${path}`, { method }) } as never);
const render = (page: ReturnType<typeof aiUsePage>) => renderInRouter(() => createElement(AiUse, { loaderData: page } as never), "/ai-use");

describe("public AI use", () => {
  it("uses actual configured models and settings without making a provider call", () => {
    const fetch = vi.fn(() => { throw new Error("A public information page must not call providers"); });
    vi.stubGlobal("fetch", fetch);
    const env = {
      TRANSLATION_PRIMARY: "gemini", GEMINI_API_KEY: "fictional-gemini-key", ANTHROPIC_API_KEY: "fictional-anthropic-key",
      TRANSLATION_GEMINI_MODEL: "gemini-disclosure-primary", TRANSLATION_SECONDARY: "claude", TRANSLATION_CLAUDE_MODEL: "claude-disclosure-secondary",
      TRANSLATION_RETRY_MODEL: "gemini-disclosure-retry", GEMINI_TRANSLATION_THINKING: "low",
      DIVERGENCE_JUDGE: "gemini", DIVERGENCE_JUDGE_GEMINI_MODEL: "gemini-disclosure-judge", DIVERGENCE_JUDGE_THINKING: "default", DIVERGENCE_SAMPLE_RATE: "0.25",
      VILLAGES: "1", VILLAGE_CHAT: "1", CHAT_TRANSLATION_MODEL: "gemini-disclosure-chat", CHAT_TRANSLATION_THINKING: "off",
      FIGURE_TRANSLATION: "1", FIGURE_READING_MODEL: "gemini-disclosure-figure",
      EMBEDDING_ENGINE: "gemini", EMBEDDING_MODEL: "gemini-disclosure-embedding",
      MODERATION_AI_MODEL: "gemini-disclosure-moderation", MODERATION_AI_TRIAGE_ENABLED: "1", MODERATION_SPAM_ENABLED: "1", MODERATION_AI_SPAM_ENABLED: "1",
    };
    const page = aiUsePage("en", env);
    const engines = resolveEngines(env);
    for (const [purpose, model] of [
      ["translation-primary", engines.primary.model], ["translation-secondary", engines.secondary!.model], ["translation-retry", engines.retry!.model],
      ["chat-translation", engines.chat!.model], ["translation-check", engines.judge!.model], ["figure-reading", createFigureReader(env).model],
      ["figure-translation", engines.primary.model], ["source-language", sourceLanguageConfig(env).model],
      ["search-embedding", resolveEmbeddingEngine(env).model], ["report-triage", moderationAiConfig(env).model], ["spam-detection", moderationAiConfig(env).model],
    ]) expect(row(page, purpose)).toMatchObject({ enabled: true, model });
    expect(row(page, "translation-primary").provider).toBe("Google");
    expect(row(page, "translation-secondary").provider).toBe("Anthropic");
    expect(row(page, "translation-primary").settings).toContain(m.ai_use_thinking({ setting: "low" }));
    expect(row(page, "chat-translation").settings).toContain(m.ai_use_thinking({ setting: "off" }));
    expect(row(page, "translation-check").settings).toContain(m.ai_use_sampling({ rate: "25%" }));
    expect(row(page, "search-embedding").settings).toContain(m.ai_use_dimensions({ count: resolveEmbeddingEngine(env).dim }));
    expect(row(page, "source-language").model).not.toBe(engines.primary.model);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors disabled features, both spam switches and the actual comparison sampling condition", () => {
    const page = aiUsePage("en", fake);
    for (const purpose of ["translation-secondary", "translation-retry", "chat-translation", "translation-check", "figure-reading", "figure-translation", "report-triage", "spam-detection"]) {
      expect(row(page, purpose)).toMatchObject({ enabled: false, model: null, status: m.ai_use_disabled(), unrecorded: false });
    }
    const comparison = { ...fake, TRANSLATION_SECONDARY: "fake", DIVERGENCE_JUDGE: "fake" };
    expect(row(aiUsePage("en", comparison), "translation-secondary").enabled).toBe(true);
    expect(row(aiUsePage("en", comparison), "translation-check").enabled).toBe(false);
    expect(row(aiUsePage("en", { ...comparison, DIVERGENCE_SAMPLE_RATE: "1" }), "translation-check").enabled).toBe(true);
    expect(row(aiUsePage("en", { ...fake, MODERATION_AI_SPAM_ENABLED: "1" }), "spam-detection").enabled).toBe(false);
    expect(row(aiUsePage("en", { ...fake, VILLAGE_CHAT: "1" }), "chat-translation").enabled).toBe(false);
  });

  it.each(["en", "ja"] as const)("keeps keys, credentials, internal endpoints and prices out of HTML, Markdown and loader data in %s", async locale => {
    const env = { ...secrets, TRANSLATION_PRIMARY: "gemini", TRANSLATION_GEMINI_MODEL: "gemini-disclosure-primary", EMBEDDING_ENGINE: "gemini", EMBEDDING_MODEL: "gemini-disclosure-embedding" };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    setTestLocale(locale);
    const page = loader();
    const outputs = [JSON.stringify(page), await render(page), await (await md(`/ai-use.md?lang=${locale}`)).text()];
    for (const output of outputs) {
      expect(output).toContain("gemini-disclosure-primary");
      for (const secret of [...Object.values(secrets), "password-sentinel-omega", "mail-password-sentinel-omega", "177.777", "222.222"]) expect(output).not.toContain(secret);
      for (const key of Object.keys(secrets)) expect(output).not.toContain(key);
    }
  });

  it.each(["en", "ja"] as const)("withholds current and historical model names that equal loaded secrets in %s", async locale => {
    for (const secret of Object.values(secrets)) {
      const env = { ...secrets, TRANSLATION_PRIMARY: "gemini", TRANSLATION_GEMINI_MODEL: secret, EMBEDDING_ENGINE: "fake" };
      const config = settings();
      config.history = [{ ...config.history[0], fromModel: secret, toModel: secret }];
      const page = aiUsePage(locale, env, config);
      const withheld = m.ai_use_unknown_model({}, { locale });
      expect(row(page, "translation-primary")).toMatchObject({ model: withheld, unrecorded: false });
      expect(page.history[0]).toMatchObject({ fromModel: withheld, toModel: withheld });
      for (const output of [JSON.stringify(page), await render(page), aiUseMarkdown(page)]) {
        expect(output).toContain(withheld);
        expect(output).not.toContain(secret);
      }
    }
  });

  it("withholds URL-shaped model names and never returns raw resolver errors", async () => {
    const secret = "http://127.0.0.1:9199/model-credential-sentinel";
    const page = aiUsePage("en", { ...fake, TRANSLATION_RETRY_MODEL: secret });
    expect(row(page, "translation-retry")).toMatchObject({ enabled: true, model: m.ai_use_unknown_model() });
    for (const output of [JSON.stringify(page), await render(page), aiUseMarkdown(page)]) expect(output).not.toContain(secret);
    vi.stubEnv("TRANSLATION_PRIMARY", "invalid-provider-credential-sentinel");
    expect(loader).toThrow("AI configuration is unavailable");
    const response = await md();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("invalid-provider-credential-sentinel");
  });

  it("compares the latest dated change per use, handles same-day order and records disabling as null", async () => {
    const config = settings();
    const first = config.history[0];
    config.history = [
      { ...first, date: "2026-03-01", toModel: resolveEngines(fake).primary.model },
      { ...first, date: "2026-01-01", toModel: "fake-older" },
      { ...first, date: "2026-02-01", toModel: "fake-middle" },
    ];
    const matched = aiUsePage("en", fake, config);
    const primaryOnly = (page: typeof matched) => ({ ...page, rows: [row(page, "translation-primary")] });
    expect(row(matched, "translation-primary").unrecorded).toBe(false);
    for (const output of [await render(primaryOnly(matched)), aiUseMarkdown(primaryOnly(matched))]) expect(output).not.toContain(matched.unrecorded);
    config.history.push({ ...first, date: "2026-03-01", toModel: "fake-unrecorded" });
    const changed = aiUsePage("en", fake, config);
    expect(row(changed, "translation-primary").unrecorded).toBe(true);
    for (const output of [await render(primaryOnly(changed)), aiUseMarkdown(primaryOnly(changed))]) expect(output).toContain(changed.unrecorded);
    expect(changed.history[0].toModel).toBe("fake-unrecorded");
    config.history.push({ ...first, purpose: "translation-retry", toModel: "fake-retired" });
    expect(row(aiUsePage("en", fake, config), "translation-retry").unrecorded).toBe(true);
    config.history.push({ ...first, purpose: "translation-retry", toModel: null });
    expect(row(aiUsePage("en", fake, config), "translation-retry").unrecorded).toBe(false);
  });

  it.each(["en", "ja"] as const)("serves empty history, missing review and a general objection route in %s", async locale => {
    const page = aiUsePage(locale, fake, { history: [], humanReview: null, objectionsUrl: null });
    const html = await render(page);
    expect(html).toContain(page.noHistory);
    expect(html).toContain(page.reviewText);
    expect(html).toContain(page.objectionsText);
    expect(aiUseMarkdown(page)).toContain(page.noHistory);
    expect(html).toContain(page.unrecorded);
    expect(aiUseMarkdown(page)).toContain(page.unrecorded);
    expect(row(page, "translation-primary").unrecorded).toBe(true);
    expect(page.objectionsUrl).toBeNull();
    expect(publicOperatorSettings(locale)).not.toHaveProperty("aiUse");
  });

  it("escapes operator prose in both representations and falls back to English for missing editions", async () => {
    const config = settings();
    config.humanReview = { en: '<script>alert("review")</script> [link](javascript:alert)', ja: "日本語の確認範囲" };
    config.history[0].reason = { en: '<img src=x onerror="alert(1)">', ja: "架空の理由" };
    config.history[0].evidenceUrl = "/comparisons/(draft)";
    config.objectionsUrl = "https://example.org/objections)";
    const page = aiUsePage("fr", fake, config);
    const html = await render(page);
    const markdown = aiUseMarkdown(page);
    expect(page.reviewText).toBe(config.humanReview.en);
    expect(html).toContain("&lt;script&gt;");
    for (const output of [html, markdown]) {
      expect(output).not.toContain('<script>alert("review")</script>');
      expect(output).not.toContain('<img src=x onerror="alert(1)">');
    }
    expect(markdown).toContain("\\[link\\]");
    expect(markdown).toContain("(/comparisons/%28draft%29)");
    expect(markdown).toContain("(https://example.org/objections%29)");
  });

  it("serves anonymous Markdown and HEAD with strict method/language validation and matching metadata", async () => {
    const response = await md();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const blocks = parseBlocks(await response.text());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].fm).toMatchObject({ type: "page", id: "ai-use", lang: "en" });
    expect(blocks[0].body).toContain("/privacy");
    expect(blocks[0].body).toContain("/principles");
    expect(blocks[0].body).toContain("/stats");
    expect((await md("/ai-use.md?lang=unknown")).status).toBe(400);
    expect((await md("/ai-use.md", "POST")).status).toBe(405);
    const head = await md("/ai-use.md", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    setTestLocale("ja");
    const page = loader();
    expect(headers()).toMatchObject({ "X-Robots-Tag": "noindex" });
    expect(meta({ loaderData: page } as never)).toContainEqual({ tagName: "link", rel: "alternate", type: "text/markdown", href: "/ai-use.md?lang=ja" });
    expect(parseBlocks(await (await md("/ai-use.md?lang=ja")).text())[0].fm.lang).toBe("ja");
  });
});
