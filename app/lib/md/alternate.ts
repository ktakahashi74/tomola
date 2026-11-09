import { isLang } from "~/lib/languages";
import { parsePageParam } from "~/lib/pagination";

// Carry the screen's supported filters, language and page to its Markdown alternate. The followed list supports asks and all; its activity order is fixed.
// Ignore malformed values and transient controls. This helper runs in the browser too, so it has no server imports.
export function listAlternateQuery(search: string, { streamFilters = true }: { streamFilters?: boolean } = {}): string {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  const lang = params.get("lang");
  if (isLang(lang)) out.set("lang", lang);
  if (params.get("asks") === "1") out.set("asks", "1");
  if (!streamFilters && params.get("all") === "1") out.set("all", "1");
  if (streamFilters && params.get("long") === "1") out.set("long", "1");
  const order = params.get("order");
  if (streamFilters && (order === "created" || order === "activity" || order === "insightful")) out.set("order", order);
  const page = parsePageParam(params.get("page"));
  if (page !== null && page > 1) out.set("page", String(page));
  const text = out.toString();
  return text ? `?${text}` : "";
}
