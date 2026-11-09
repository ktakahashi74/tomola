import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/settings-chat";
import { requireMember } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { CHAT_PRIVATE_HEADERS } from "~/lib/village-chat-auth.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { ChatError } from "~/lib/village-chat";
import { CHAT_OWN_DELETE_LIMIT } from "~/lib/village-chat-delete.server";
import { deleteOwnChat, ownChatPage } from "~/lib/village-chat-own.server";
import { parsePageParam } from "~/lib/pagination";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { LocalTime } from "~/components/local-time";
import { Pagination } from "~/components/pagination";
import { m } from "~/paraglide/messages.js";
import { CHAT_REPORT_RETAIN_DAYS } from "~/lib/chat-access";

export const middleware = [privateCacheMiddleware];
export function headers() { return CHAT_PRIVATE_HEADERS; }
export function meta({ loaderData }: Route.MetaArgs) { return loaderData ? [{ title: m.village_chat_own_title() }, { name: "robots", content: "noindex" }] : []; }
export async function loader({ request }: Route.LoaderArgs) {
  if (!villageChatEnabled()) throw data("Not found", { status: 404 });
  const { db, user } = await requireMember(request);
  const search = new URL(request.url).searchParams;
  const page = parsePageParam(search.get("page"));
  if (page === null) throw data("Not found", { status: 404 });
  const deleted = Number(search.get("deleted"));
  return { ...await ownChatPage(db, user.id, { page }), deleteLimit: CHAT_OWN_DELETE_LIMIT, deleted: search.has("deleted") && Number.isSafeInteger(deleted) && deleted >= 0 && deleted <= CHAT_OWN_DELETE_LIMIT ? deleted : null, more: search.get("more") === "1" };
}
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (!villageChatEnabled()) throw data("Not found", { status: 404 });
  const { db, user } = await requireMember(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent !== "delete" && intent !== "delete-village") throw data("Bad request", { status: 400 });
  if (intent === "delete-village" && form.get("confirm") !== "1") return data({ error: "confirm" }, { status: 400 });
  const rate = await hitMemberLimit(db, "chat-delete", user.id);
  if (!rate.allowed) return data({ error: "limit" }, { status: 429, headers: rateLimitHeaders(rate) });
  try {
    const result = await deleteOwnChat(db, user.id, form.get("id"), intent === "delete-village");
    const params = new URLSearchParams({ deleted: String(result.count) });
    const page = parsePageParam(new URL(request.url).searchParams.get("page"));
    if (page && page > 1) params.set("page", String(page));
    if (result.more) params.set("more", "1");
    throw redirect(`/settings/chat?${params}`);
  } catch (error) {
    if (!(error instanceof ChatError)) throw error;
    throw data(error.code === "invalid" ? "Bad request" : "Not found", { status: error.code === "invalid" ? 400 : 404 });
  }
}
export default function OwnChat({ loaderData, actionData }: Route.ComponentProps) {
  return <main className="mx-auto max-w-3xl space-y-4 [overflow-wrap:anywhere]">
    <h1 className="text-2xl font-bold">{m.village_chat_own_title()}</h1>
    <Link to="/settings#settings-export" className="underline">{m.settings_title()}</Link>
    <p>{m.village_chat_own_help()}</p>
    <p>{m.village_chat_own_retention({ days: CHAT_REPORT_RETAIN_DAYS })}</p>
    {actionData?.error && <p role="alert">{actionData.error === "limit" ? m.village_chat_limit() : m.village_chat_own_confirm({ count: loaderData.deleteLimit })}</p>}
    {loaderData.deleted !== null && <p role="status">{m.village_chat_own_deleted({ count: loaderData.deleted })}{loaderData.more && <> {m.village_chat_own_more()}</>}</p>}
    {!loaderData.groups.length && <p>{m.village_chat_own_empty()}</p>}
    {loaderData.groups.map(group => <section key={group.anchor} className="space-y-3 rounded border p-3">
      <h2 className="text-lg font-semibold">{group.village.name}</h2>
      {group.messages.map(message => <article key={message.id} data-own-chat={message.id} className="space-y-2 border-t pt-3">
        <p className="flex flex-wrap gap-2 ui-meta text-muted-foreground"><LocalTime iso={message.createdAt} />{message.hidden && <span>{m.village_chat_hidden()}</span>}</p>
        <p lang={message.lang} className="whitespace-pre-wrap">{message.body}</p>
        <div className="flex flex-wrap items-center gap-3 ui-meta">
          {message.href && <Link to={message.href} className="underline">{m.notification_open()}</Link>}
          <Form method="post"><input type="hidden" name="id" value={message.id} /><Button name="intent" value="delete" type="submit" variant="outline" size="sm">{m.village_chat_delete()}</Button></Form>
        </div>
      </article>)}
      <Form method="post" className="space-y-2 border-t pt-3"><input type="hidden" name="id" value={group.anchor} />
        <label className="flex items-center gap-2 text-sm"><Checkbox name="confirm" value="1" />{m.village_chat_own_confirm({ count: loaderData.deleteLimit })}</label>
        <Button name="intent" value="delete-village" type="submit" variant="destructive" size="sm">{m.village_chat_own_delete_all()}</Button>
      </Form>
    </section>)}
    <Pagination page={loaderData.page} hasNext={loaderData.hasNext} dropParams={["deleted", "more"]} />
  </main>;
}
