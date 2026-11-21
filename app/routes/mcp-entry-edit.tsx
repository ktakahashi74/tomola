import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/mcp-entry-edit";
import { entryErrorMessage } from "~/components/entry-fields";
import { SendButton, SignedForm, SigningChanges } from "~/components/signed-form";
import { Button } from "~/components/ui/button";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { replyLocation } from "~/lib/entries.server";
import { formString, readEntryForm } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { languageLabel } from "~/lib/language-label";
import { MarkdownBusyError } from "~/lib/markdown-budget.server";
import { applyEntryEdit, discardEntryEdit, getEntryEditReview } from "~/lib/mcp/post-proposals.server";
import { failure, parseId, parseIdOrNull } from "~/lib/params.server";
import { editedLocation } from "~/lib/posted-ui";
import { SigningFailureResponse, signingViewToken, withSignedWrite } from "~/lib/signing.server";
import { titleOrNull } from "~/lib/text";
import { m } from "~/paraglide/messages.js";

const privateHeaders = { "Cache-Control": "private, no-store" };
export const headers = () => privateHeaders;

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  const review = await getEntryEditReview(db, user.id, parseId(params.id));
  if (!review) failure("not_found");
  const { proposal, current, back } = review;
  const content = current && proposal.body !== null && proposal.lang !== null ? {
    title: proposal.title, body: proposal.body, lang: proposal.lang,
  } : null;
  return data({ id: proposal.id, version: proposal.version, clientName: proposal.clientName, clientKey: proposal.clientKey,
    createdAt: proposal.createdAt.toISOString(), back, current, content, signPosts: profile.signPosts,
    signingView: current ? signingViewToken({ userId: user.id, kind: "entry", id: current.id, version: current.sourceHash ?? "", title: current.title, body: current.body, lang: current.lang }) : null,
  }, { headers: privateHeaders });
}

export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { user, db } = await requireWriter(request);
  const id = parseId(params.id);
  const form = await request.formData();
  const version = parseIdOrNull(formString(form, "version"));
  if (version === null || version > 2_147_483_647) throw data("Bad request", { status: 400 });
  const refuse = (error: string, status: number, headers: HeadersInit = privateHeaders) => data({ error }, { status, headers });
  const intent = formString(form, "intent");
  if (intent === "discard") {
    const review = await getEntryEditReview(db, user.id, id);
    if (!review) failure("not_found");
    if (!await discardEntryEdit(db, user.id, id, version)) return refuse("edit_conflict", 409);
    throw redirect(review.back);
  }
  if (intent !== "apply") throw data("Bad request", { status: 400 });
  const entryId = parseIdOrNull(formString(form, "entryId"));
  const kind = formString(form, "entryKind");
  if (entryId === null || (kind !== "topic" && kind !== "reply")) throw data("Bad request", { status: 400 });
  const { title, body, lang } = readEntryForm(form);
  await enforceMemberLimit(db, "edit", user.id);
  try {
    const result = await withSignedWrite(db, user.id, request, form, tx => applyEntryEdit(tx, user.id, id, { version, entryId, kind, title: titleOrNull(title), body, lang }));
    if (result.ok) {
      const path = result.kind === "topic" ? `/t/${result.id}` : await replyLocation(db, result.threadId, result.id);
      throw redirect(editedLocation(path, result.id));
    }
    if (result.error === "not_found" || result.error === "forbidden") failure("not_found");
    return refuse(result.error, result.error === "edit_conflict" || result.error === "locked" ? 409 : 400);
  } catch (error) {
    if (error instanceof SigningFailureResponse) return refuse(error.code === "approval_changed" ? "edit_conflict" : error.code, error.status);
    if (error instanceof MarkdownBusyError) return refuse("busy", 503, { ...privateHeaders, "Retry-After": "1" });
    throw error;
  }
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.mcp_entry_edit_review() }];
}

export const handle = { writing: true };

export default function EntryEditReview({ loaderData, actionData }: Route.ComponentProps) {
  const { id, version, current, content, back, clientName, clientKey, createdAt, signPosts, signingView } = loaderData;
  const conflict = !current || actionData?.error === "edit_conflict" || actionData?.error === "locked";
  return <main className="space-y-4">
    <h1 className="text-xl font-bold">{m.mcp_entry_edit_review()}</h1>
    <p className="ui-meta text-muted-foreground">{m.signing_last_ai({ name: clientName, id: clientKey, at: createdAt })}</p>
    {conflict ? <p role="alert" className="text-destructive">{m.mcp_entry_proposal_conflict()}</p>
      : actionData?.error && <p role="alert" className="text-destructive">{entryErrorMessage(actionData.error, current.kind)}</p>}
    {current && content && <>
      <div className="space-y-2 rounded border p-3">
        {content.title && <h2 dir="auto" className="font-semibold">{content.title}</h2>}
        <p className="ui-meta text-muted-foreground">{m.original_lang({ lang: languageLabel(content.lang) })}</p>
        <pre dir="auto" className="whitespace-pre-wrap break-words">{content.body}</pre>
        <SigningChanges preview={{ current, content, viewed: null }} />
      </div>
      <SignedForm method="post" signatureRequired={signPosts} signIntent="apply">
        <input type="hidden" name="version" value={version} />
        <input type="hidden" name="entryId" value={current.id} />
        <input type="hidden" name="entryKind" value={current.kind} />
        <input type="hidden" name="title" value={content.title ?? ""} />
        <input type="hidden" name="body" value={content.body} />
        <input type="hidden" name="lang" value={content.lang} />
        {signingView && <input type="hidden" name="signingView" value={signingView} />}
        <SendButton intent="apply">{m.mcp_entry_apply()}</SendButton>
      </SignedForm>
    </>}
    <div className="flex flex-wrap items-center gap-4">
      <Form method="post">
        <input type="hidden" name="version" value={version} />
        <Button type="submit" name="intent" value="discard" variant="outline">{m.draft_delete()}</Button>
      </Form>
      <Link to={back} className="ui-meta underline">{m.cancel()}</Link>
    </div>
  </main>;
}
