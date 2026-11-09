import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/mod-chat-translations";
import { requireModerator } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { parseId, parsePage } from "~/lib/params.server";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { CHAT_PRIVATE_HEADERS } from "~/lib/village-chat-auth.server";
import { ChatTranslationReportError, chatTranslationReportMetadata, listChatTranslationReports, moderateChatTranslationReport, readChatTranslationReport } from "~/lib/chat-translation-reports.server";
import { LANG_LABELS, isLang } from "~/lib/languages";
import { Button } from "~/components/ui/button";
import { Pagination } from "~/components/pagination";
import { m } from "~/paraglide/messages.js";
export const middleware = [privateCacheMiddleware];
export function headers() { return CHAT_PRIVATE_HEADERS; }
export function meta() { return [{ title: m.chat_translation_reports_title() }, { name: "robots", content: "noindex" }]; }
function failure(error: unknown): never {
  const status = error instanceof ChatTranslationReportError ? error.code === "unavailable" ? 503 : error.code === "closed" ? 409 : 404 : 503;
  throw data(status === 503 ? "Service unavailable" : "Not found", { status, headers: CHAT_PRIVATE_HEADERS });
}
export async function loader({ request }: Route.LoaderArgs) {
  const { db, user, scope } = await requireModerator(request); await enforceMemberLimit(db, "mod", user.id);
  const actor = { id: user.id, scope }, id = new URL(request.url).searchParams.get("id");
  const selectedId = id ? parseId(id) : null;
  try {
    const result = await listChatTranslationReports(db, actor, parsePage(request));
    const selectedCase = selectedId ? await chatTranslationReportMetadata(db, actor, selectedId) : null;
    const selected = selectedCase && { id: selectedCase.id, sourceLang: selectedCase.sourceLang, lang: selectedCase.lang, status: selectedCase.status };
    return data({ ...result, selected }, { headers: CHAT_PRIVATE_HEADERS });
  } catch (error) { return failure(error); }
}
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user, scope } = await requireModerator(request); await enforceMemberLimit(db, "mod", user.id);
  const form = await request.formData(), id = parseId(String(form.get("id") ?? "")), intent = form.get("intent"), actor = { id: user.id, scope };
  try {
    if (intent === "open") return data({ id, evidence: await readChatTranslationReport(db, actor, id) }, { headers: CHAT_PRIVATE_HEADERS });
    if (intent !== "hide" && intent !== "dismiss") throw new ChatTranslationReportError("invalid");
    await moderateChatTranslationReport(db, actor, id, intent);
  } catch (error) { return failure(error); }
  return redirect("/mod/chat-translations", { headers: CHAT_PRIVATE_HEADERS });
}
const label = (lang: string) => isLang(lang) ? LANG_LABELS[lang] : lang;
export default function ChatTranslationReports({ loaderData, actionData }: Route.ComponentProps) {
  const selected = loaderData.selected;
  const evidence = selected && actionData?.id === selected.id ? actionData.evidence : null;
  return <main className="space-y-4 [overflow-wrap:anywhere]">
    <h1 className="text-2xl font-bold">{m.chat_translation_reports_title()}</h1><Link to="/mod" className="underline">{m.mod_title()}</Link>
    {selected && <section className="space-y-3 rounded border p-3">
      <p>{label(selected.sourceLang)} → {label(selected.lang)}</p>
      {selected.status === "open" && <Form method="post" className="flex flex-wrap gap-3"><input type="hidden" name="id" value={selected.id} />
        <Button type="submit" name="intent" value="open">{m.chat_reports_open()}</Button>
        <Button type="submit" name="intent" value="hide" variant="outline">{m.chat_translation_hide()}</Button>
        <Button type="submit" name="intent" value="dismiss" variant="outline">{m.mod_dismiss()}</Button>
      </Form>}
      {evidence && <><h2>{m.village_chat_translation_original()}</h2><p lang={evidence.sourceLang} className="whitespace-pre-wrap">{evidence.original}</p><h2>{m.village_chat_translation_show()}</h2><p lang={evidence.lang} className="whitespace-pre-wrap">{evidence.translation}</p><p className="whitespace-pre-wrap">{evidence.note}</p></>}
    </section>}
    <ul className="space-y-2">{loaderData.items.map(item => <li key={item.id}><Link className="underline" to={`?id=${item.id}`}>#{item.id} · {label(item.sourceLang)} → {label(item.lang)}</Link></li>)}</ul>
    {!loaderData.items.length && <p>{m.mod_empty()}</p>}
    <Pagination page={loaderData.page} hasNext={loaderData.hasNext} />
  </main>;
}
