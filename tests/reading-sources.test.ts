import { expect, it } from "vitest";
import { isAiCrawler, isBrowserRobot, readingSource } from "~/lib/reading-sources.server";

it("classifies only domain boundaries and gives internal navigation precedence over shares", () => {
  const classify = (host?: string, internal = false, shared = false) => readingSource(host, "forum.example", internal, shared);
  expect(classify()).toBe("none");
  expect(classify("www.google.com")).toBe("search");
  expect(classify("GEMINI.GOOGLE.COM.")).toBe("ai");
  expect(classify("chatgpt.com")).toBe("ai");
  expect(classify("t.co")).toBe("social");
  expect(classify("google.com.evil.example")).toBe("other_site");
  expect(classify("notgoogle.com")).toBe("other_site");
  expect(classify("forum.example")).toBe("internal");
  expect(classify("forum.example", false, true)).toBe("internal");
  expect(classify("elsewhere.example", false, true)).toBe("share_link");
  expect(classify("chatgpt.com", true, true)).toBe("internal");
});
it("recognizes self-declared AI tokens without treating ordinary search bots as AI", () => {
  for (const token of ["GPTBot/1.0", "Mozilla/5.0 (compatible; ClaudeBot/1.0)", "PerplexityBot", "CCBot/2.0", "ChatGPT-User/1.0"]) expect(isAiCrawler(token)).toBe(true);
  for (const token of ["Googlebot/2.1", "bingbot", "Mozilla/5.0", "NotGPTBot", "GPTBot-Fake"]) expect(isAiCrawler(token)).toBe(false);
});

it("preserves legacy browser robot rejection independently of the new AI classifier", () => {
  expect(isBrowserRobot("ChatGPT-User-custom")).toBe(true);
  expect(isBrowserRobot("Claude-User-custom")).toBe(true);
  expect(isBrowserRobot("Google-Extended")).toBe(false);
  expect(isAiCrawler("Google-Extended")).toBe(false);
});

it("classifies country search hosts and additional engines without accepting lookalikes", () => {
  for (const host of ["google.fr", "www.google.de", "google.co.kr", "www.google.com.au", "google.cat", "bing.com", "cn.bing.com", "search.yahoo.com", "search.yahoo.co.jp", "duckduckgo.com", "baidu.com", "yandex.ru", "yandex.kz", "yandex.com.tr", "search.naver.com", "search.daum.net", "search.brave.com", "ecosia.org", "qwant.com", "startpage.com", "search.aol.com", "ask.com", "seznam.cz", "sogou.com", "so.com"]) {
    expect(readingSource(host, "forum.example", false, false), host).toBe("search");
  }
  for (const host of ["google.com.evil.example", "google.co.uk.evil.example", "google.com.au.evil.example", "notgoogle.fr", "notnaver.com", "naver.com.evil.example", "google.x", "google.co.abc"]) {
    expect(readingSource(host, "forum.example", false, false), host).toBe("other_site");
  }
  for (const host of ["grok.com", "chat.deepseek.com", "chat.mistral.ai", "poe.com"]) expect(readingSource(host, "forum.example", false, false)).toBe("ai");
});
it("matches additional AI HTTP tokens and excludes robots.txt-only and retired tokens", () => {
  for (const token of ["meta-externalagent", "Meta-ExternalFetcher", "MistralAI-User", "DuckAssistBot"]) {
    expect(isAiCrawler(`Mozilla/5.0 (compatible; ${token}/1.0)`)).toBe(true);
    expect(isAiCrawler(`${token}-Fake`)).toBe(false);
  }
  for (const token of ["Google-Extended", "Applebot-Extended", "anthropic-ai", "cohere-ai"]) expect(isAiCrawler(token)).toBe(false);
});
