// Shared pages are browser-supplied strings only. This module never retrieves a URL.
const clean = (text: string, keepNewlines = false) => text.replace(/\r\n?|\u2028|\u2029/g, "\n").replace(/[\p{Cc}\p{Cf}\u034f]/gu, (char) => keepNewlines && char === "\n" ? char : "").trim();
const truncate = (text: string, limit: number) => Array.from(text).slice(0, limit).join("");

function httpUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || Array.from(value).length > 2000 || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    // URL serialization also escapes angle brackets and normalizes backslashes; parentheses need additional Markdown escaping.
    return parsed.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return null;
  }
}

export function sharePrefill(params: URLSearchParams): { title: string; body: string } | null {
  let url = params.get("url") ?? "";
  let text = clean(params.get("text") ?? "", true);
  if (!url) {
    const match = text.match(/https?:\/\/[^\s<>"']+/i);
    if (!match) return null;
    url = match[0];
    text = `${text.slice(0, match.index)}${text.slice(match.index! + url.length)}`.trim();
  }
  const destination = httpUrl(url);
  if (!destination) return null;
  const originalTitle = clean(params.get("title") ?? "");
  const title = truncate(originalTitle, 300);
  const label = (title || url).replace(/[\\[\]]/g, "\\$&");
  const comparison = clean(text);
  text = comparison === url || comparison === originalTitle || comparison === title ? "" : truncate(text, 1000);
  const quote = text ? text.split("\n").map((line) => `> ${line}`).join("\n") : "";
  return { title: "", body: `[${label}](${destination})\n\n${quote ? `${quote}\n\n` : ""}` };
}
