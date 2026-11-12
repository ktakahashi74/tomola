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
  for (const token of ["GPTBot/1.0", "Mozilla/5.0 (compatible; ClaudeBot/1.0)", "PerplexityBot", "Google-Extended", "CCBot/2.0", "ChatGPT-User/1.0"]) expect(isAiCrawler(token)).toBe(true);
  for (const token of ["Googlebot/2.1", "bingbot", "Mozilla/5.0", "NotGPTBot", "GPTBot-Fake"]) expect(isAiCrawler(token)).toBe(false);
});

it("preserves legacy browser robot rejection independently of the new AI classifier", () => {
  expect(isBrowserRobot("ChatGPT-User-custom")).toBe(true);
  expect(isBrowserRobot("Claude-User-custom")).toBe(true);
  expect(isBrowserRobot("Google-Extended")).toBe(false);
  expect(isAiCrawler("Google-Extended")).toBe(true);
});
