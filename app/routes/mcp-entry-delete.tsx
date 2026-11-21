import { data, Form, Link, redirect, type ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/mcp-entry-delete";
import { Button } from "~/components/ui/button";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { replyLocation } from "~/lib/entries.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { confirmEntryDeletion, getEntryDeletionReview } from "~/lib/mcp/post-proposals.server";
import { failure, parseId } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";

const privateHeaders = { "Cache-Control": "private, no-store" };
export const headers = () => privateHeaders;

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, db } = await requireMember(request);
  const review = await getEntryDeletionReview(db, user.id, parseId(params.id));
  if (!review) failure("not_found");
  return data(review, { headers: privateHeaders });
}

export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { user, db } = await requireWriter(request);
  const id = parseId(params.id);
  const form = await request.formData();
  const count = formString(form, "count");
  const version = formString(form, "version");
  if (formString(form, "confirm") !== "1" || !/^\d{1,16}$/.test(count) || !Number.isSafeInteger(Number(count)) || !version) throw data("Bad request", { status: 400 });
  const result = await confirmEntryDeletion(db, user.id, id, { count: Number(count), version });
  if (result.ok) throw redirect(result.kind === "topic" ? "/" : await replyLocation(db, result.threadId, id));
  if (result.error === "delete_conflict") return data({ conflict: true }, { status: 409, headers: privateHeaders });
  failure("not_found");
}

export function shouldRevalidate({ actionResult, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return actionResult?.conflict === true || defaultShouldRevalidate;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.delete_summary() }];
}

export default function EntryDeletionReview({ loaderData, actionData }: Route.ComponentProps) {
  const { entry, count, version, back } = loaderData;
  return <main className="space-y-4">
    <h1 className="text-xl font-bold">{m.delete_summary()}</h1>
    {entry.title && <h2 dir="auto" className="font-semibold">{entry.title}</h2>}
    <pre dir="auto" className="whitespace-pre-wrap break-words rounded border p-3">{entry.body}</pre>
    <p>{entry.kind === "topic" ? m.delete_warning_topic() : m.delete_warning_reply()}</p>
    <p>{entry.kind === "topic" ? m.mcp_entry_delete_impact({ count }) : m.mcp_entry_delete_reply_impact({ count })}</p>
    {actionData?.conflict && <p role="alert" className="text-destructive">{m.mcp_entry_delete_conflict()}</p>}
    <Form method="post" className="flex flex-wrap items-center gap-4">
      <input type="hidden" name="count" value={count} />
      <input type="hidden" name="version" value={version} />
      <Button variant="destructive" type="submit" name="confirm" value="1">{m.delete_confirm()}</Button>
      <Link to={back} className="ui-meta underline">{m.cancel()}</Link>
    </Form>
  </main>;
}
