import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/entry-history";
import { LocalTime } from "~/components/local-time";
import { getReader, requireMember } from "~/lib/auth/session.server";
import { deleteEntryRevision, readEntryHistory } from "~/lib/entry-history.server";
import { replyLocation } from "~/lib/entries.server";
import { historyDiff, type HistoryChange } from "~/lib/history-diff.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { parseId } from "~/lib/params.server";
import { MEMBER_CONTENT_HEADERS } from "~/lib/api/http.server";
import { serveHistoryMarkdown } from "~/lib/md/history-http.server";
import { m } from "~/paraglide/messages.js";

export const middleware: Route.MiddlewareFunction[] = [async ({ request, params }, next) => {
  const match = /^(current|[1-9]\d*)\.(?:md|txt)$/.exec(params.version ?? "");
  return match ? serveHistoryMarkdown(request, params.id, match[1]) : next();
}];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { db, user } = await getReader(request);
  const history = await readEntryHistory(db, parseId(params.id), user?.id ?? null, params.version, true);
  if (!history || (new URL(request.url).pathname.startsWith("/c/") !== (history.kind === "reply"))) throw data("Not found", { status: 404 });
  const back = history.kind === "topic" ? `/t/${history.id}` : await replyLocation(db, history.threadId, history.id);
  const selected = history.selected;
  return { history, back, selectedVersion: params.version, confirm: new URL(request.url).searchParams.get("delete") === "1",
    diff: selected?.previous ? { title: historyDiff(selected.previous.title ?? "", selected.title ?? ""), body: historyDiff(selected.previous.body, selected.body) } : null };
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") throw data("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  assertSameOrigin(request);
  const { db, user } = await requireMember(request);
  await enforceMemberLimit(db, "edit", user.id);
  const form = await request.formData();
  if (form.get("confirm") !== "delete") throw data("Bad request", { status: 400 });
  const id = parseId(params.id), revisionId = parseId(params.version);
  const prefix = new URL(request.url).pathname.startsWith("/c/") ? "c" : "t";
  const result = await deleteEntryRevision(db, user.id, id, revisionId, new Date(), prefix === "c" ? "reply" : "topic");
  if (!result.ok) {
    if (result.error !== "protected") throw data("Not found", { status: result.error === "forbidden" ? 403 : 404 });
    return data({ error: "protected" }, { status: 409 });
  }
  throw redirect(`/${prefix}/${id}/history/${revisionId}`);
}
// Native HTML form posts need the site's HTML policy to retain their Origin.
export function headers() { return { ...MEMBER_CONTENT_HEADERS, "Referrer-Policy": "strict-origin-when-cross-origin" }; }
export function meta() { return [{ title: m.history_title() }, { name: "robots", content: "noindex" }]; }

function Diff({ changes }: { changes: HistoryChange[] }) {
  return <div className="whitespace-pre-wrap break-words">{changes.map((change, i) => change.kind === "same" ? <span key={i}>{change.text}</span> : change.kind === "removed"
    ? <del key={i} className="bg-muted"><span className="sr-only">{m.history_removed()}: </span>{change.text}</del>
    : <ins key={i} className="border-b-2"><span className="sr-only">{m.history_added()}: </span>{change.text}</ins>)}</div>;
}

export default function EntryHistory({ loaderData, actionData }: Route.ComponentProps) {
  const { history, back, confirm, diff } = loaderData;
  const selectedId = loaderData.selectedVersion;
  const version = history.versions.find(v => v.id === selectedId);
  const canDelete = history.owner && version && !version.current && !version.deleted;
  return <main className="mx-auto max-w-3xl space-y-6 break-words">
    <h1 className="text-2xl font-bold">{m.history_title()}</h1>
    <Link to={back} className="underline">{m.history_back()}</Link>
    <ol className="space-y-3" aria-label={m.history_title()}>{history.versions.map((v, i) => <li key={v.id}>
      <Link to={`${history.path}/${v.id}`} className={selectedId === v.id ? "underline font-semibold" : "underline"} aria-current={selectedId === v.id ? "page" : undefined}>
        {i === 0 ? m.history_posted() : m.history_updated()} <LocalTime iso={v.at} style="stamp" />
      </Link>{v.deleted && <> · {m.history_deleted()}</>}{v.current && <> · {m.history_current()}</>}
    </li>)}</ol>
    {history.selected && <article className="space-y-4" data-history-original="">
      <p className="ui-meta" data-history-version="">{selectedId === history.versions[0].id ? m.history_posted() : m.history_updated()} <LocalTime iso={history.selected.at} style="stamp" />{history.selected.current && <> · {m.history_current()}</>}</p>
      {history.selected.title && <h2 className="text-xl font-bold whitespace-pre-wrap">{history.selected.title}</h2>}
      <pre className="whitespace-pre-wrap break-words font-[inherit]">{history.selected.body}</pre>
      {diff && <section className="space-y-3" data-history-diff=""><h2 className="text-xl font-bold">{m.history_diff()}</h2>
        <p className="ui-meta"><ins>{m.history_added()}</ins> · <del>{m.history_removed()}</del></p>
        <Diff changes={diff.title} /><Diff changes={diff.body} />
      </section>}
    </article>}
    {canDelete && (version.protected || actionData?.error === "protected" ? <p role="status">{m.history_protected()}</p> : confirm
      ? <Form method="post" className="space-y-3"><p>{m.history_delete_confirm()}</p><input type="hidden" name="confirm" value="delete" />
        <button className="underline" type="submit">{m.history_delete()}</button>{" · "}<Link to={`${history.path}/${version.id}`} className="underline">{m.cancel()}</Link>
      </Form> : <Link to={`?delete=1`} className="underline">{m.history_delete()}</Link>)}
    <p><a href={`${history.path}${selectedId ? `/${selectedId}` : ""}.md`} className="ui-meta underline">{m.open_in_ai_noscript()}</a></p>
  </main>;
}
