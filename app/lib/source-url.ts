import { isDevOrTest } from "~/lib/env.server";

// SOURCE_URL: where the source code of this site is published (AGPL-3.0-or-later). When it is set, the footer of every page links to it ("Source").
// Empty or unset: no link. A value that is not an http(s) URL is refused at startup (assertStartupConfig calls this), so a link never points at javascript: or the like.
// In production it must be https (the link is shown to every visitor), and it must not carry a user name or a password (they would be shown in the page source). Development and
// tests may use http, so that a local server can be linked.
export function sourceUrl(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.SOURCE_URL?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SOURCE_URL is not a valid URL (expected https://example.org/tomola)");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("SOURCE_URL must be an http:// or https:// URL");
  if (parsed.protocol === "http:" && !isDevOrTest(env)) throw new Error("SOURCE_URL must be an https:// URL in production");
  if (parsed.username !== "" || parsed.password !== "") throw new Error("SOURCE_URL must not contain a user name or a password");
  return parsed.href;
}
