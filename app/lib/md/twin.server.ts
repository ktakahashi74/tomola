import { villagesEnabled } from "~/lib/villages-enabled.server";
import { data } from "react-router";
import { villageBySlug } from "~/lib/villages.server";
import { errorResponse, guarded, memberResponse, methodNotAllowed, notFound } from "~/lib/api/http.server";
import { authenticatePageRead } from "~/lib/api/page-read-auth.server";
import { allowsPublicListRead, buildListMarkdown, type ListSpec } from "~/lib/md/lists.server";
import { buildThreadMarkdown, canReadThreadPublicly } from "~/lib/md/thread.server";
import { enabledLangs, isEnabledLang } from "~/lib/enabled-langs.server";
import { isLang, type Lang } from "~/lib/languages";
import { parsePageParam } from "~/lib/pagination";
import { parseIdOrNull, parseOrderParam } from "~/lib/params.server";
import type { TopicOrder } from "~/lib/entries.server";
import { resolveDisplayLang } from "~/lib/display";
import type { Db } from "~/lib/db/client.server";

// Page Markdown twins: .md and .txt both return identical text/plain; charset=utf-8 content.
//
// React Router dynamic segments cannot have suffixes (:id.md). /t/1042.md reaches t/:id with id="1042.md".
// Use route server middleware on t/:id and a/:lang to return text only for .md/.txt suffixes,
// without calling next() or the screen loader. Ordinary pages proceed through next().
// Authenticate here without running HTML loaders: selected twins allow public reads when enabled; protected twins still return 401.

const MD_SEGMENT = /^(.+)\.(?:md|txt)$/;

// Stem without extension in "1042.md"/"ja.txt"; null without .md/.txt, indicating a normal page.
export function mdStem(segment: string | undefined): string | null {
  return segment ? (MD_SEGMENT.exec(segment)?.[1] ?? null) : null;
}

// 405 except for GET/HEAD.
function gate(request: Request): Response | null {
  return request.method === "GET" || request.method === "HEAD" ? null : methodNotAllowed(request, "text", "GET, HEAD");
}

type Query = { page: number; lang: Lang | null; allTranslations: boolean; sentences: boolean; asks: boolean; long: boolean; order: TopicOrder | null };

// ?page= (1 when absent; malformed is 404), ?lang= (absent uses the member's stored defaults; invalid is 400), ?sentences=1, ?asks=1 (questions only), ?long=1 (long posts only: topics with
// a title), ?order=created|activity|insightful (null when absent: the list's own default; any other value is 400 invalid_order).
function parseQuery(request: Request, streamFilters = true, allowAll = false): Query | Response {
  const params = new URL(request.url).searchParams;
  const page = parsePageParam(params.get("page"));
  if (page === null) return notFound(request, "text");
  const langParam = params.get("lang");
  const allTranslations = allowAll && langParam === "all";
  if (langParam !== null && !allTranslations && !isEnabledLang(langParam)) return errorResponse(request, "text", 400, "invalid_lang", `?lang= must be one of the languages of this site: ${enabledLangs().join(", ")}${allowAll ? ", or all" : ""}.`);
  const order = streamFilters ? parseOrderParam(params.get("order")) : null;
  if (order === "invalid") return errorResponse(request, "text", 400, "invalid_order", "?order= must be created (new posts first), activity (the last activity first), or insightful (most Insightful marks first, newest first for equal counts).");
  return { page, lang: allTranslations ? null : langParam as Lang | null, allTranslations, sentences: params.get("sentences") === "1", asks: params.get("asks") === "1", long: streamFilters && params.get("long") === "1", order };
}

// /t/:id.md
export async function serveThreadMd(request: Request, stem: string): Promise<Response> {
  const blocked = gate(request);
  if (blocked) return blocked;
  return guarded(request, "text", "md-thread", () => threadMd(request, stem));
}

async function threadMd(request: Request, stem: string): Promise<Response> {
  const authed = await authenticatePageRead(request);
  if (!authed.ok) return authed.response;
  const { auth } = authed;
  const id = parseIdOrNull(stem);
  if (id === null) return notFound(request, "text");
  const query = parseQuery(request, true, true);
  if (query instanceof Response) return query;
  const lang = resolveDisplayLang({ query: query.lang, profile: auth.profile ?? { displayLang: null, readLangs: [] }, uiLocale: auth.profile?.uiLocale, enabled: enabledLangs() });
  const markdown = await buildThreadMarkdown(auth.db, id, { ...query, lang: query.allTranslations ? "all" : lang, displayLang: lang, k: auth.carryK, readLangs: auth.profile?.readLangs ?? [], readerId: auth.profile?.userId });
  return markdown === null ? notFound(request, "text") : memberResponse(request, markdown, { rate: auth.rate });
}

// /a/:lang.md, /latest.md and /home.md. Null from resolve gives 404 after membership authentication.
async function serveList(request: Request, resolve: () => ListSpec | null): Promise<Response> {
  const blocked = gate(request);
  if (blocked) return blocked;
  return guarded(request, "text", "md-list", () => listMd(request, resolve));
}

async function listMd(request: Request, resolve: () => ListSpec | null): Promise<Response> {
  const spec = resolve();
  const authed = await authenticatePageRead(request, allowsPublicListRead(spec));
  if (!authed.ok) return authed.response;
  const { auth } = authed;
  if (spec === null) return notFound(request, "text");
  const query = parseQuery(request, spec.kind !== "following");
  if (query instanceof Response) return query;
  const lang = resolveDisplayLang({ query: query.lang, profile: auth.profile ?? { displayLang: null, readLangs: [] }, uiLocale: auth.profile?.uiLocale, enabled: enabledLangs() });
  const params = new URL(request.url).searchParams;
  const all = spec.kind === "following" && params.get("all") === "1";
  const markdown = await buildListMarkdown(auth.db, auth.profile, spec, { all, page: query.page, lang, k: auth.carryK, asks: query.asks, long: query.long, order: query.order });
  return memberResponse(request, markdown, { rate: auth.rate });
}

export const serveListMd = (request: Request, spec: ListSpec): Promise<Response> => serveList(request, () => spec);
export const serveAreaMd = (request: Request, stem: string): Promise<Response> =>
  serveList(request, () => (isLang(stem) ? { kind: "area", lang: stem } : null));

// Public-capability selection uses the same target and list rules as the twins.
// Protected API/export resources and hidden placeholders retain member delegation.
export async function canReadMarkdownPublicly(db: Db, resource: string): Promise<boolean> {
  const path = new URL(resource, "http://tomola.invalid").pathname.replace(/\.txt$/, ".md");
  const topic = /^\/t\/([1-9]\d*)\.md$/.exec(path);
  if (topic) {
    const id = parseIdOrNull(topic[1]);
    return id !== null && await canReadThreadPublicly(db, id);
  }
  const area = /^\/a\/([A-Za-z-]+)\.md$/.exec(path);
  if (area) return isLang(area[1]) && allowsPublicListRead({ kind: "area", lang: area[1] });
  if (path === "/home.md") return allowsPublicListRead({ kind: "home" });
  if (path === "/latest.md") return allowsPublicListRead({ kind: "latest" });
  if (path === "/following.md") return allowsPublicListRead({ kind: "following" });
  return false;
}

// Route middleware: args.params belongs to t/:id or a/:lang.
type MiddlewareArgs = { request: Request; params: Record<string, string | undefined> };
type Next = () => Promise<Response>;

export async function threadMdMiddleware({ request, params }: MiddlewareArgs, next: Next): Promise<Response> {
  const stem = mdStem(params.id);
  return stem === null ? next() : serveThreadMd(request, stem);
}

export async function areaMdMiddleware({ request, params }: MiddlewareArgs, next: Next): Promise<Response> {
  const stem = mdStem(params.lang);
  return stem === null ? next() : serveAreaMd(request, stem);
}

export async function serveVillagesMd(request: Request): Promise<Response> {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  return serveListMd(request, { kind: "villages" });
}

export async function serveVillageMd(request: Request, slug: string): Promise<Response> {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  const blocked = gate(request);
  if (blocked) return blocked;
  return guarded(request, "text", "md-village", async () => {
    const authed = await authenticatePageRead(request);
    if (!authed.ok) return authed.response;
    const { auth } = authed;
    const village = await villageBySlug(auth.db, slug);
    if (!village?.slug) return notFound(request, "text");
    const query = parseQuery(request);
    if (query instanceof Response) return query;
    const lang = resolveDisplayLang({ query: query.lang, profile: auth.profile ?? { displayLang: null, readLangs: [] }, uiLocale: auth.profile?.uiLocale, enabled: enabledLangs() });
    const markdown = await buildListMarkdown(auth.db, auth.profile, { kind: "village", slug: village.slug, villageId: village.id }, { ...query, lang, k: auth.carryK });
    return memberResponse(request, markdown, { rate: auth.rate });
  });
}

export async function villageMdMiddleware({ request, params }: MiddlewareArgs, next: Next): Promise<Response> {
  if (!villagesEnabled()) return next();
  const stem = mdStem(params.slug);
  return stem === null ? next() : serveVillageMd(request, stem);
}
