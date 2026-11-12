// Classification lists live only on the server. Raw hosts and user agents are
// used transiently and must never be logged or stored with reading aggregates.
export const READING_METHODS = ["browser", "markdown", "api", "mcp", "ai_crawler"] as const;
export const READING_SOURCES = ["share_link", "search", "social", "ai", "other_site", "none", "internal"] as const;
export type ReadingMethod = typeof READING_METHODS[number];
export type ReadingSource = typeof READING_SOURCES[number];
export const REFERRER_DOMAINS = {
  ai: ["chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com", "perplexity.ai", "copilot.microsoft.com", "copilot.com"],
  search: ["google.com", "google.co.jp", "google.co.uk", "bing.com", "duckduckgo.com", "search.yahoo.com", "search.yahoo.co.jp", "baidu.com", "yandex.com", "yandex.ru", "search.brave.com", "ecosia.org"],
  social: ["x.com", "twitter.com", "t.co", "facebook.com", "instagram.com", "threads.net", "threads.com", "bsky.app", "linkedin.com", "lnkd.in", "reddit.com", "mastodon.social", "mstdn.jp", "misskey.io", "youtube.com", "news.ycombinator.com"],
} as const;
// These are self-declared tokens, not verified crawler identities. Search bots
// without an AI-specific token are deliberately absent.
export const AI_CRAWLER_TOKENS = ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai", "PerplexityBot", "Perplexity-User", "Google-Extended", "CCBot", "Bytespider", "Amazonbot", "Applebot-Extended", "cohere-ai"] as const;
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
    if (REFERRER_DOMAINS[kind].some(domain => normalized === domain || normalized.endsWith(`.${domain}`))) return kind;
  }
  return "other_site";
}
