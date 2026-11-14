import { isLang, type Lang } from "./languages";

// Changing original-language lists retains only stream choices, resetting pagination and transient status.
export function originalLanguagePath(search: string, lang: Lang | null): string {
  const params = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    if (["order", "asks", "long", "lang"].includes(key)) params.append(key, value);
  }
  const query = params.toString();
  return `${lang === null ? "/" : `/a/${lang}`}${query ? `?${query}` : ""}`;
}

export function navigationSection(path: string): "home" | "villages" | "following" | "notifications" | null {
  if (path === "/" || path.startsWith("/a/")) return "home";
  if (path === "/villages" || path.startsWith("/villages/") || path.startsWith("/v/")) return "villages";
  if (path === "/following") return "following";
  if (path === "/notifications") return "notifications";
  return null;
}

export function sideNavigationPath(pathname: string): boolean {
  const path = pathname.replace(/\/$/, "") || "/";
  if (["/", "/villages", "/following", "/saved", "/notifications"].includes(path)) return true;
  if (/^\/a\/[^/]+$/.test(path)) return isLang(path.slice(3));
  if (/^\/u\/[^/]+$/.test(path)) return true;
  return /^\/v\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/chat)?$/i.test(path);
}

export function villageWritingHref(path: string, joined: readonly { slug: string | null }[]): string {
  const slug = /^\/v\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/chat)?\/?$/i.exec(path)?.[1]?.toLowerCase();
  return slug && joined.some(village => village.slug === slug) ? `/t/new?${new URLSearchParams({ village: slug })}` : "/t/new";
}
