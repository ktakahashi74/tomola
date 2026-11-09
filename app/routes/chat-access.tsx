import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { data, Link } from "react-router";
import type { Route } from "./+types/chat-access";
import { requireOperator } from "~/lib/auth/session.server";
import { listChatAccessLog } from "~/lib/village-chat-reports.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { CHAT_PRIVATE_HEADERS } from "~/lib/village-chat-auth.server";
import { parsePage } from "~/lib/params.server";
import { Pagination } from "~/components/pagination";
import { CHAT_AI_TRIAGE_REASON, CHAT_APPEAL_REVIEW_REASON, CHAT_REPORT_REVIEW_REASON, chatAccessFreeReason } from "~/lib/chat-access";
import { villageName } from "~/lib/village-name";
import { m } from "~/paraglide/messages.js";

export const middleware = [privateCacheMiddleware];
export function headers() { return CHAT_PRIVATE_HEADERS; }
export function meta() { return [{ title: m.chat_access_title() }, { name: "robots", content: "noindex" }]; }
export async function loader({ request }: Route.LoaderArgs) {
  const { db, user } = await requireOperator(request);
  const result = await listChatAccessLog(db, { id: user.id, scope: { operator: true, langs: [] } }, parsePage(request));
  if (!villageChatEnabled() && !result.items.length && !(await listChatAccessLog(db, { id: user.id, scope: { operator: true, langs: [] } }, 1, 1)).items.length) throw data("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS });
  return data({ ...result, items: result.items.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })) }, { headers: CHAT_PRIVATE_HEADERS });
}
export default function ChatAccess({ loaderData }: Route.ComponentProps) {
  return <main className="space-y-4 [overflow-wrap:anywhere]">
    <h1 className="text-2xl font-bold">{m.chat_access_title()}</h1>
    {!loaderData.items.length && <p>{m.chat_access_empty()}</p>}
    <ul className="space-y-3">{loaderData.items.map(row => <li key={row.id} className="space-y-1 rounded border p-3">
      <p>{row.readerKind === "ai" ? `${m.mod_ai_reader()} (${row.readerHandle})` : `@${row.readerHandle}`} · <time dateTime={row.createdAt}>{row.createdAt}</time></p>
      {row.translationReportId !== null ? <Link className="underline" to={`/mod/chat-translations?id=${row.translationReportId}`}>{m.chat_translation_reports_title()} #{row.translationReportId}</Link> : <Link className="underline" to={`/mod/chat/${row.reportId !== null ? "report" : "appeal"}/${row.reportId ?? row.appealId}`}>{row.reportId !== null ? m.chat_access_report({ id: row.reportId }) : m.chat_access_appeal({ id: row.appealId! })}</Link>}
      {/* Localize nonpublic village kind labels when those kinds are introduced. */}
      <p>{row.village.name === null ? <>{m.village_kind()}: {row.village.kind}</> : row.village.slug === null ? villageName({ name: row.village.name, language: row.village.language }) : <Link className="underline" to={`/v/${row.village.slug}`}>{villageName({ name: row.village.name, language: row.village.language })}</Link>}</p>
      <p>{row.kind === "snapshot" ? m.chat_reports_snapshot() : m.chat_reports_context()} · {row.ranges.length ? row.ranges.map(range => m.chat_access_range(range)).join(" · ") : m.chat_access_no_messages()}</p>
      <p>{row.reason === "chat:translation-review" ? m.chat_translation_reports_title() : row.reason === CHAT_AI_TRIAGE_REASON ? m.mod_ai_assessment() : row.reason === CHAT_REPORT_REVIEW_REASON ? m.chat_access_report_review() : row.reason === CHAT_APPEAL_REVIEW_REASON ? m.chat_access_appeal_review() : chatAccessFreeReason(row.reason)}</p>
    </li>)}</ul>
    <Pagination page={loaderData.page} hasNext={loaderData.hasNext} />
  </main>;
}
