// Classification lists live only on the server. Raw hosts and user agents are
// used transiently and must never be logged or stored with reading aggregates.
export const READING_METHODS = ["browser", "markdown", "api", "mcp", "ai_crawler"] as const;
export const READING_SOURCES = ["share_link", "search", "social", "ai", "other_site", "none", "internal"] as const;
export type ReadingMethod = typeof READING_METHODS[number];
export type ReadingSource = typeof READING_SOURCES[number];
export const REFERRER_DOMAINS = {
  ai: ["chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com", "perplexity.ai", "copilot.microsoft.com", "copilot.com", "grok.com", "chat.deepseek.com", "chat.mistral.ai", "poe.com"],
  // Country-domain rules are anchored at the host boundary, like literal domains.
  search: [/(?:^|\.)google\.(?:[a-z]{2,}|(?:co|com)\.[a-z]{2})$/, "bing.com", "duckduckgo.com", "yahoo.com", "yahoo.co.jp", "baidu.com", "yandex.com", "yandex.ru", "yandex.kz", "yandex.by", "yandex.uz", "yandex.com.tr", "naver.com", "daum.net", "search.brave.com", "ecosia.org", "qwant.com", "startpage.com", "search.aol.com", "ask.com", "seznam.cz", "sogou.com", "so.com"],
  social: ["x.com", "twitter.com", "t.co", "facebook.com", "instagram.com", "threads.net", "threads.com", "bsky.app", "linkedin.com", "lnkd.in", "reddit.com", "mastodon.social", "mstdn.jp", "misskey.io", "youtube.com", "news.ycombinator.com"],
} as const;
// These are self-declared tokens, not verified crawler identities. Search bots
// without an AI-specific token are deliberately absent. Robots.txt-only controls
// (Google-Extended, Applebot-Extended) and retired tokens are not HTTP UA tokens.
export const AI_CRAWLER_TOKENS = ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User", "CCBot", "Bytespider", "Amazonbot", "meta-externalagent", "Meta-ExternalFetcher", "MistralAI-User", "DuckAssistBot"] as const;
// Preserve the established browser-only translation-report rejection rule.
// Additional AI tokens are rejected only for the new reading notification.
export function isBrowserRobot(agent: string): boolean {
  return /bot|crawler|spider|slurp|GPTBot|ChatGPT-User|Claude-User|Perplexity/i.test(agent);
}
export function isAiCrawler(agent: string): boolean {
  return AI_CRAWLER_TOKENS.some(token => new RegExp(`(?:^|[^a-z0-9_-])${token}(?:$|[^a-z0-9_-])`, "i").test(agent));
}
export function readingSource(host: string | undefined, ownHost: string, internal: boolean, shared: boolean): ReadingSource {
  if (internal) return "internal";
  const normalized = host?.toLowerCase().replace(/\.$/, "");
  if (normalized === ownHost.toLowerCase()) return "internal";
  if (shared) return "share_link";
  if (!normalized) return "none";
  for (const kind of ["ai", "search", "social"] as const) {
    if (REFERRER_DOMAINS[kind].some(domain => typeof domain === "string" ? normalized === domain || normalized.endsWith(`.${domain}`) : domain.test(normalized))) return kind;
  }
  return "other_site";
}
