import { data, Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/village-chat-search";
import { requireMember } from "~/lib/auth/session.server";
import { chatAccess } from "~/lib/village-chat.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { findChatMessages } from "~/lib/village-chat-search.server";
import { displayLangFor, langQueryParam } from "~/lib/display-lang.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { CHAT_PRIVATE_HEADERS } from "~/lib/village-chat-auth.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { checkQuery, MAX_QUERY_LENGTH } from "~/lib/search";
import { chatSequence } from "~/lib/village-chat";
import { villageName } from "~/lib/village-name";
import { ChatSearchResults } from "~/components/chat-search-results";
import { PageHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { m } from "~/paraglide/messages.js";

export const middleware = [privateCacheMiddleware];
export function headers({ actionHeaders }: Route.HeadersArgs) {
  const headers = new Headers(CHAT_PRIVATE_HEADERS);
  for (const [name, value] of actionHeaders) if (/^(allow|retry-after|x-ratelimit-)/i.test(name)) headers.set(name, value);
  return headers;
}
export function meta() { return [{ title: m.chat_search_title() }, { name: "robots", content: "noindex" }]; }

export async function loader({ request, params }: Route.LoaderArgs) {
  if (!villageChatEnabled()) throw data("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS });
  const { db, user } = await requireMember(request);
  const access = await chatAccess(db, params.slug, user.id);
  if (!access?.consented) return data({ unavailable: true as const }, { status: 404, headers: CHAT_PRIVATE_HEADERS });
  return { unavailable: false as const, slug: params.slug, name: villageName(access.village), linkLang: langQueryParam(request) };
}

export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (!villageChatEnabled()) throw data("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS });
  if (request.method !== "POST") throw data("Method not allowed", { status: 405, headers: { ...CHAT_PRIVATE_HEADERS, Allow: "GET, HEAD, POST" } });
  const { db, user, profile } = await requireMember(request);
  const access = await chatAccess(db, params.slug, user.id);
  if (!access?.consented) return data({ error: "not_found" as const }, { status: 404, headers: CHAT_PRIVATE_HEADERS });
  let form: FormData;
  try { form = await request.formData(); }
  catch { return data({ error: "invalid" as const }, { status: 400, headers: CHAT_PRIVATE_HEADERS }); }
  const raw = form.get("q");
  const checked = checkQuery(typeof raw === "string" ? raw : "");
  const before = form.has("before") ? chatSequence(form.get("before")) : undefined;
  if (!checked.ok || checked.query.includes("\0") || before === null || before === 0) return data({ error: "invalid" as const }, { status: 400, headers: CHAT_PRIVATE_HEADERS });
  const rate = await hitMemberLimit(db, "chat-search", user.id);
  if (!rate.allowed) return data({ error: "limit" as const }, { status: 429, headers: { ...CHAT_PRIVATE_HEADERS, ...rateLimitHeaders(rate) } });
  try {
    const result = await findChatMessages(db, access.village.id, checked.query, displayLangFor(request, profile), before);
    return data({ query: checked.query, ...result }, { headers: CHAT_PRIVATE_HEADERS });
  } catch {
    // A database failure can contain bound query text. Do not log or rethrow it.
    return data({ error: "unavailable" as const }, { status: 503, headers: CHAT_PRIVATE_HEADERS });
  }
}

export default function ChatSearch({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  if (loaderData.unavailable || actionData && "error" in actionData && actionData.error === "not_found") return <main><p role="status">{m.chat_search_message_unavailable()}</p></main>;
  const result = actionData && "hits" in actionData ? actionData : null;
  const error = actionData && "error" in actionData ? actionData.error : null;
  const busy = navigation.state !== "idle";
  const action = `/v/${loaderData.slug}/chat/search${loaderData.linkLang ? `?lang=${loaderData.linkLang}` : ""}`;
  return <main className="mx-auto max-w-3xl space-y-4 [overflow-wrap:anywhere]">
    <PageHeader title={m.chat_search_title()} purpose={loaderData.name} actions={<Link className="underline ui-help" to={`/v/${loaderData.slug}/chat${loaderData.linkLang ? `?lang=${loaderData.linkLang}` : ""}`}>{m.chat_search_back()}</Link>} />
    <Form method="post" action={action} role="search" aria-label={m.chat_search_title()} autoComplete="off" className="flex gap-2">
      <Input type="search" name="q" aria-label={m.chat_search_title()} defaultValue={result?.query ?? ""} maxLength={MAX_QUERY_LENGTH} required autoComplete="off" className="min-w-0 flex-1" />
      <Button type="submit" disabled={busy}>{m.search_button()}</Button>
    </Form>
    <p className="ui-help text-muted-foreground">{m.chat_search_incomplete()}</p>
    {error && <p role="alert">{error === "limit" ? m.village_chat_limit() : error === "invalid" ? m.chat_search_invalid({ max: MAX_QUERY_LENGTH }) : m.error_body_unavailable()}</p>}
    {result && !error && <section aria-busy={busy} className="space-y-3">
      <h2 className="heading-2">{m.chat_search_results()}</h2>
      {result.hits.length ? <ChatSearchResults hits={result.hits} slug={loaderData.slug} linkLang={loaderData.linkLang} /> : <p>{m.chat_search_empty()}</p>}
      {result.before !== null && <Form method="post" action={action} autoComplete="off">
        <input type="hidden" name="q" value={result.query} /><input type="hidden" name="before" value={result.before} />
        <Button type="submit" variant="outline" disabled={busy}>{m.chat_search_more()}</Button>
      </Form>}
    </section>}
  </main>;
}
