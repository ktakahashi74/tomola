import { enforceMemberLimit } from "~/lib/http/limits.server";
import { MarkdownBusyError, withMarkdownRead } from "~/lib/markdown-budget.server";
import { LongFormBody } from "~/components/long-form-body";
import { data, Link, redirect } from "react-router";
import type { Route } from "./+types/topic-edit";
import { TopicEntryEditForm } from "~/components/topic-entry-edit-form";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { entryErrorMessage } from "~/components/entry-fields";
import { editEntry, getEditableEntry } from "~/lib/entries.server";
import { formString, readEntryForm } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { fixEntry } from "~/lib/moderation.server";
import { failure, parseId } from "~/lib/params.server";
import { getViewer } from "~/lib/roles.server";
import { m } from "~/paraglide/messages.js";
import { SigningFailureResponse, signingViewToken, withSignedWrite } from "~/lib/signing.server";
import { editedLocation } from "~/lib/posted-ui";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { topicVillage } from "~/lib/villages.server";
import { localizeVillage } from "~/lib/village-translations.server";
import { villageReaderFor } from "~/lib/display-lang.server";
import { postingVillageName } from "~/lib/village-name";
import { entryEditVersion } from "~/lib/entry-edit-version.server";
import { editConflict, editFormValues, editFormVersion } from "~/lib/edit-form.server";

// Accessible to the author, assigned moderators, and operators; otherwise 403. Check edit permissions server-side in both loader and action.
// For questions locked by a stance (mode: "author-locked"), show authors guidance instead of a form: add clarifications in replies, or create an alternative-framing question to change propositions or conditions.
// For locked questions, moderators assigned the source language and operators (mode: "moderator-fix") receive a typo-correction form requiring an explanation, recorded as fix_entry and notified to the author
// Moderators cannot correct their own questions.
async function loaderImplementation({ request, params }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  const viewer = await getViewer(db, user);
  const found = await getEditableEntry(db, user.id, parseId(params.id), { kind: "topic", viewer });
  if (!found.ok) failure(found.error);
  const { id, kind, lang, title, body, asksStance, mode } = found.entry;
  // The base of the moderator's fix form (see fixEntry): the hash of the text the form was opened on.
  const sourceHash = mode === "moderator-fix" ? (found.entry.sourceHash ?? "") : null;
  const village = villagesEnabled() ? await topicVillage(db, id) : null;
  const destination = village?.kind === "personal" ? { ...village, name: village.slug ?? village.name } : village;
  return { ownerId: user.id, entry: { id, kind, lang, title, body }, asksStance, locked: mode === "author-locked", fix: mode === "moderator-fix", sourceHash,
    destination: villagesEnabled() ? destination ? postingVillageName(await localizeVillage(db, destination, villageReaderFor(request, profile)), profile.handle) : m.village_target_unavailable() : null,
    signPosts: profile.signPosts, editVersion: entryEditVersion(found.entry),
    signingView: signingViewToken({ userId: user.id, kind: "entry", id, version: found.entry.sourceHash ?? "", title, body, lang }) };
}

// Moderator correction errors reuse existing moderation and post-validation messages.
function fixErrorMessage(error: string): string {
  switch (error) {
    case "no_change":
      return m.edit_fix_no_change();
    case "forbidden":
      return m.mod_error_forbidden();
    case "own_entry":
      return m.mod_error_own();
    // A fix is only offered on a locked question, so for a fix this means the form is stale: the text was changed after the page was opened.
    case "invalid_state":
      return m.edit_fix_stale();
    case "note_required":
      return m.mod_error_note_required();
    case "invalid_note":
      return m.mod_error_note();
    case "not_found":
      return m.mod_error_not_found();
    default:
      return entryErrorMessage(error);
  }
}

export async function action({ request, params }: Route.ActionArgs) {

  const retained = request.clone();
  try {
    // From another site, nothing may change (CSRF). Checked before the login, the form or anything else is read (the rule in app/lib/http/csrf.server.ts).
    // This is also the entry point of the moderator's fix (fix_entry).
    assertSameOrigin(request);
    const { user, db } = await requireWriter(request);
    await enforceMemberLimit(db, "edit", user.id);
    const id = parseId(params.id);
    const form = await request.formData();
    const { title, body, lang } = readEntryForm(form);
    const viewer = await getViewer(db, user);
    const found = await getEditableEntry(db, user.id, id, { kind: "topic", viewer });
    if (!found.ok) failure(found.error);
    // Assigned moderators and operators may correct typos in locked questions (fix_entry).
    if (found.entry.mode === "moderator-fix") {
      const note = formString(form, "note");
      const fixed = await withSignedWrite(db, user.id, request, form, tx => fixEntry(tx, { id: user.id, scope: viewer.scope }, { entryId: id, title, body, note, sourceHash: formString(form, "sourceHash") }));
      if (fixed.ok) throw redirect(`/t/${id}`);
      if (fixed.error === "not_found") failure("not_found");
      if (fixed.error === "forbidden") failure("forbidden");
      // A stale form: show the current text (not the moderator's input, which was written over the old text), so the fix is made again knowingly.
      if (fixed.error === "invalid_state") return data({ error: fixed.error, fix: true, values: undefined }, { status: 409 });
      return data({ error: fixed.error, fix: true, values: { title, body, note } }, { status: 400 });
    }
    const res = await withSignedWrite(db, user.id, request, form, tx => editEntry(tx, user.id, id, { title, body, ...(form.has("lang") ? { lang } : {}) }, { kind: "topic", expectedVersion: editFormVersion(form) }));
    if (res.ok) throw redirect(editedLocation(`/t/${res.id}`, res.id));
    if (res.error === "not_found" || res.error === "forbidden") failure(res.error);
    // The first stance arrived between loading and submission; reopen this screen to switch to guidance.
    if (res.error === "locked") throw redirect(`/t/${id}/edit`);
    return data({ error: res.error, fix: false, values: editFormValues(form), conflict: editConflict(res.error, `/t/${id}/edit`) }, { status: res.error === "edit_conflict" ? 409 : 400 });
  }
  catch (error) {
    if (!(error instanceof MarkdownBusyError) && !(error instanceof SigningFailureResponse)) throw error;
    const form = await retained.formData();
    const code = error instanceof SigningFailureResponse ? error.code : "busy";
    return data({ error: code, fix: formString(form, "sourceHash") !== "", values: editFormValues(form), conflict: editConflict(code, `/t/${parseId(params.id)}/edit`) }, { status: error instanceof SigningFailureResponse ? error.status : 503, headers: error instanceof SigningFailureResponse ? { "Cache-Control": "private, no-store" } : { "Retry-After": "1" } });
  }

}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.edit_topic_title() }];
}

export default function TopicEdit({ loaderData, actionData }: Route.ComponentProps) {
  const { entry, asksStance, locked, fix, sourceHash, signingView } = loaderData;
  const materialLink = <Link className="underline ui-meta" to={`/t/${entry.id}/ai-materials/edit`}>{m.ai_material_title()}</Link>;
  const destination = loaderData.destination && <div data-village-target className="space-y-1">
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm"><span>{m.field_village()}</span><span className="wrap-anywhere">{loaderData.destination}</span></div>
    <p className="ui-help text-muted-foreground">{m.village_public_reach()}</p>
  </div>;
  if (locked) {
    return (
      <main className="space-y-4">
        <h1 className="text-2xl font-bold">{m.edit_locked_title()}</h1>
        <p>{m.edit_locked_body()}</p>{materialLink}
        <p className="flex flex-wrap items-center gap-4">
          <Link to={`/t/${entry.id}#reply`} className="underline">
            {m.edit_locked_reply()}
          </Link>
          <Link to={`/t/new?asks_stance=1&alt_of=${entry.id}`} className="underline">
            {m.objections_new_alt()}
          </Link>
          <Link to={`/t/${entry.id}`} className="underline">
            {m.cancel()}
          </Link>
        </p>
      </main>
    );
  }
  if (fix) {
    return (
      <TopicEntryEditForm
        destination={destination}
        BodyEditor={LongFormBody}
        // A fix is only offered on a locked question, and a question always has its title, so the field stays required (the loader's asksStance is for the author's form).
        entry={{ ...entry, asksStance: true }}
        error={actionData?.error}
        errorText={actionData?.error ? fixErrorMessage(actionData.error) : undefined}
        values={actionData?.values}
        heading={m.edit_fix_title()}
        cancelTo={`/t/${entry.id}`}
        warning={m.edit_fix_typo_help()}
        fixNote
        baseSourceHash={sourceHash ?? ""}
        keeper={{ owner: loaderData.ownerId, scope: `edit:topic:${entry.id}` }}
        signingView={signingView}
        signPosts={loaderData.signPosts}
      />
    );
  }
  return (
    <TopicEntryEditForm
      destination={<>{destination}{materialLink}</>}
      BodyEditor={LongFormBody}
      entry={{ ...entry, asksStance }}
      key={entry.id}
      editVersion={loaderData.editVersion}
      conflict={actionData && "conflict" in actionData ? actionData.conflict : undefined}
      error={actionData?.error}
      values={actionData?.values}
      heading={m.edit_topic_title()}
      cancelTo={`/t/${entry.id}`}
      warning={asksStance ? m.edit_lock_warning() : undefined}
      keeper={{ owner: loaderData.ownerId, scope: `edit:topic:${entry.id}` }}
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
