import { enforceMemberLimit } from "~/lib/http/limits.server";
import { MarkdownBusyError, withMarkdownRead } from "~/lib/markdown-budget.server";
import { data, redirect } from "react-router";
import type { Route } from "./+types/reply-edit";
import { EntryEditForm } from "~/components/entry-edit-form";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { editEntry, getEditableEntry, replyLocation } from "~/lib/entries.server";
import { readEntryForm } from "~/lib/entry-form.server";
import { failure, parseId } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { SigningFailureResponse, signingViewToken, withSignedWrite } from "~/lib/signing.server";
import { editedLocation } from "~/lib/posted-ui";
import { entryEditVersion } from "~/lib/entry-edit-version.server";
import { editConflict, editFormValues, editFormVersion } from "~/lib/edit-form.server";

// Only the author may open this route (403 for others). Check edit permissions server-side in both loader and action.
async function loaderImplementation({ request, params }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  const found = await getEditableEntry(db, user.id, parseId(params.id), { kind: "reply" });
  if (!found.ok) failure(found.error);
  const { id, kind, threadId, lang, title, body, stanceTag, threadAsksStance } = found.entry;
  // Include the return location: the reply's thread page. Also show tag selection if the topic is a question.
  return { ownerId: user.id, entry: { id, kind, threadId, lang, title, body }, stanceTag, threadAsksStance, back: await replyLocation(db, threadId, id),
    signPosts: profile.signPosts, editVersion: entryEditVersion(found.entry),
    signingView: signingViewToken({ userId: user.id, kind: "entry", id, version: found.entry.sourceHash ?? "", title, body, lang }) };
}

export async function action({ request, params }: Route.ActionArgs) {

  const retained = request.clone();
  try {
    assertSameOrigin(request);
    const { user, db } = await requireWriter(request);
    await enforceMemberLimit(db, "edit", user.id);
    const id = parseId(params.id);
    const form = await request.formData();
    const { body, stanceTag, lang } = readEntryForm(form);
    // The author may change tags when editing; 「印なし」 removes one. Replies to non-question topics have neither selector nor tag, which remains unchanged.
    const res = await withSignedWrite(db, user.id, request, form, tx => editEntry(tx, user.id, id, { body, stanceTag, ...(form.has("lang") ? { lang } : {}) }, { kind: "reply", expectedVersion: editFormVersion(form) }));
    if (res.ok) throw redirect(editedLocation(await replyLocation(db, res.threadId, res.id), res.id));
    if (res.error === "not_found" || res.error === "forbidden") failure(res.error);
    return data({ error: res.error, values: editFormValues(form), conflict: editConflict(res.error, `/c/${id}/edit`) }, { status: res.error === "edit_conflict" ? 409 : 400 });
  }
  catch (error) {
    if (!(error instanceof MarkdownBusyError) && !(error instanceof SigningFailureResponse)) throw error;
    const form = await retained.formData();
    const code = error instanceof SigningFailureResponse ? error.code : "busy";
    return data({ error: code, values: editFormValues(form), conflict: editConflict(code, `/c/${parseId(params.id)}/edit`) }, { status: error instanceof SigningFailureResponse ? error.status : 503, headers: error instanceof SigningFailureResponse ? { "Cache-Control": "private, no-store" } : { "Retry-After": "1" } });
  }

}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.edit_reply_title() }];
}

export default function ReplyEdit({ loaderData, actionData }: Route.ComponentProps) {
  const { entry, back, stanceTag, threadAsksStance, signingView } = loaderData;
  return (
    <EntryEditForm
      entry={entry}
      key={entry.id}
      editVersion={loaderData.editVersion}
      conflict={actionData?.conflict}
      error={actionData?.error}
      values={actionData?.values}
      heading={m.edit_reply_title()}
      cancelTo={back}
      keeper={{ owner: loaderData.ownerId, scope: `edit:reply:${entry.id}` }}
      stanceTag={threadAsksStance ? { current: stanceTag } : undefined}
      signingView={signingView}
      signPosts={loaderData.signPosts}
    />
  );
}


export const handle = { writing: true };


// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
