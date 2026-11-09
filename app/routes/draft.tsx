import { MarkdownBusyError, withMarkdownRead } from "~/lib/markdown-budget.server";
import { PersistentDetails } from "~/components/persistent-details";
import { Button } from "~/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { data, Form, Link, redirect, useLocation, type ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/draft";
import { entryErrorMessage } from "~/components/entry-fields";
import { StanceTagChips } from "~/components/stance-tag";
import { TopicFields } from "~/components/topic-fields";
import { isVillageTargetError } from "~/components/village-target";
import { LongFormBody } from "~/components/long-form-body";
import { DraftAutosave } from "~/components/draft-autosave-lazy";
import { ReplyFields } from "~/components/reply-fields";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { deleteDraft, getDraft, publishDraft, removeDraftAltOf, updateDraft } from "~/lib/drafts.server";
import { replyLocation } from "~/lib/entries.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { formString, readEntryForm } from "~/lib/entry-form.server";
import { parseId } from "~/lib/params.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { postedLocation } from "~/lib/posted-ui";
import { m } from "~/paraglide/messages.js";
import { SigningFailureResponse, signingViewToken, withSignedWrite } from "~/lib/signing.server";
import { SignedForm, SendButton } from "~/components/signed-form";
import { AiEditorTools } from "~/components/ai-editor-tools";
import { titleOrNull } from "~/lib/text";
import { orBlank } from "~/lib/local-draft";
import { prehydrationBody } from "~/lib/prehydration-input";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { villageReaderFor } from "~/lib/display-lang.server";
import { postingVillages } from "~/lib/villages.server";
import { draftMdMiddleware } from "~/lib/md/draft.server";
import { draftRecoveryToken } from "~/lib/draft-recovery.server";
export const middleware: Route.MiddlewareFunction[] = [draftMdMiddleware];

// Open only the member's own drafts (404 for others). Editing, previewing, publishing, and deleting all use this screen.
// Publish only through same-origin POSTs from browser sessions. Tokens cannot publish: a token is not a session cookie,
// so it cannot pass requireMember. This screen is also where a member approves drafts submitted through the API.
// Check same-origin here in addition to React Router's built-in check: approval is the sole gate where a person can stop AI writes.
async function loaderImplementation({ request, params }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  const draft = await getDraft(db, user.id, parseId(params.id));
  if (!draft) throw data("Not found", { status: 404 });
  return { ownerId: user.id, connectDraftLabel: m.connect_draft_link(), draft, recoveryToken: await draftRecoveryToken(db, user.id, draft), signPosts: profile.signPosts, signingView: signingViewToken({ userId: user.id, kind: "draft", id: draft.id, version: String(draft.version), title: draft.title, body: draft.body, lang: draft.lang }), ...(villagesEnabled() && draft.kind === "topic" ? { posting: await postingVillages(db, user.id, draft.village, { reader: villageReaderFor(request, profile) }) } : {}) };
}

export async function action({ request, params }: Route.ActionArgs) {

  const retained = request.clone();
  try {
    assertSameOrigin(request);
    const { user, db } = await requireWriter(request);
    const id = parseId(params.id);
    const form = await request.formData();
    const intent = formString(form, "intent");

    if (intent === "delete") {
      if (!(await deleteDraft(db, user.id, id))) throw data("Not found", { status: 404 });
      throw redirect("/drafts");
    }
    if (intent !== "save" && intent !== "publish" && intent !== "remove_alt") throw data("Bad request", { status: 400 });

    // Save screen contents before publication so failed validation does not lose edits. Do the same when removing the original-question link (remove_alt).
    // Topic drafts have the 「立場を聞く」 checkbox. Alternative-framing targets are fixed at creation and cannot change here; unchecking leaves alt_of present and prevents saving.
    // Reply drafts allow tag selection only for question replies. Non-question topics have no selector and no tag. Hide the selector if the topic becomes unreadable (hidden or deleted),
    // and do not interpret an omitted tag as removal: undefined means unchanged.
    // The form carries no ai_assistance: saving keeps the value the draft already has (set by frontmatter or the API), and publishing hands it on to the post.
    const { title, body, lang, asksStance, stanceTag, village, villageExplicit, villageDisplayed } = readEntryForm(form);
    const draft = await getDraft(db, user.id, id);
    const browserDraft = draft?.via === "web" && !draft.clientId;
    const versionOptions = { returnVersion: true, ...(browserDraft ? { expectedVersion: Number(formString(form, "version")) } : {}) };
    const proof = (version: number) => signingViewToken({ userId: user.id, kind: "draft", id, version: String(version), title: draft?.kind === "topic" ? titleOrNull(title) : null, body, lang });
    async function result(error: string | null, saved = false, version?: number, altRemoved = false, status = error ? 400 : 200, resolvedVillage?: string) {
      const latest = error === "draft_conflict" ? await getDraft(db, user.id, id) : null;
      const latestView = latest ? signingViewToken({ userId: user.id, kind: "draft", id, version: String(latest.version), title: latest.title, body: latest.body, lang: latest.lang }) : null;
      // Echo unsaved input, using the new basis whenever this request saved before publication was refused.
      const target = resolvedVillage ?? village;
      const values = error ? { title, body, lang, asksStance, version: version !== undefined ? String(version) : formString(form, "version"), signingView: version !== undefined ? proof(version) : formString(form, "signingView"), ...(villagesEnabled() ? { village: target } : {}) } : null;
      return data({ error, saved, altRemoved, version, signingView: version === undefined ? undefined : proof(version), latest: latest ? { draft: latest, signingView: latestView! } : null, values, ...(villagesEnabled() && draft?.kind === "topic" ? { village: target ?? draft.village ?? null } : {}) }, { status, headers: { "Cache-Control": "private, no-store" } });
    }
    if (!draft) {
      if (form.has("version")) return result("not_found", false, undefined, false, 404);
      throw data("Not found", { status: 404 });
    }
    const input = draft.kind === "topic" ? { title, body, lang, asksStance, ...(villagesEnabled() ? { village: villageExplicit === false ? undefined : village } : {}) } : { title, body, lang, stanceTag: draft.threadAsksStance ? stanceTag : undefined };
    if (intent === "publish") {
      const rate = await hitMemberLimit(db, draft.kind === "topic" ? "topic" : "reply", user.id);
      if (!rate.allowed) {
        const refused = await result("rate_limited", false, undefined, false, 429);
        return data(refused.data, { status: 429, headers: rateLimitHeaders(rate) });
      }
      let savedVersion: number | undefined;
      let didSave = false;
      let res;
      try {
        res = await withSignedWrite(db, user.id, request, form, async tx => {
          // The conditional update is inside the signed transaction, before creating any post.
          const saved = await updateDraft(tx, user.id, id, input, versionOptions);
          if (!saved.ok) return saved;
          didSave = true;
          savedVersion = saved.version;
          return villagesEnabled() ? publishDraft(tx, user.id, id, { villageDisplayed: villageDisplayed ?? "" }) : publishDraft(tx, user.id, id);
        });
      } catch (error) {
        if (error instanceof SigningFailureResponse) return result(error.code, false, undefined, false, error.status, error.village);
        if (browserDraft && error instanceof Response && error.status === 409) return result("draft_conflict", false, undefined, false, 409);
        throw error;
      }
      if (res.ok && "id" in res) throw redirect(postedLocation(res.kind === "topic" ? `/t/${res.id}` : await replyLocation(db, res.threadId, res.id), res.id, res.kind === "reply" && res.followed));
      const error = res.ok ? null : res.error;
      if (error === "not_found" && !browserDraft) throw data("Not found", { status: 404 });
      return result(error, didSave, savedVersion, false, error === "draft_conflict" ? 409 : error === "not_found" ? 404 : 400, !res.ok && "village" in res ? res.village : undefined);
    }
    const saved = await updateDraft(db, user.id, id, input, versionOptions);
    if (!saved.ok) {
      if (saved.error === "not_found" && !browserDraft) throw data("Not found", { status: 404 });
      return result(saved.error, false, undefined, false, saved.error === "draft_conflict" ? 409 : saved.error === "not_found" ? 404 : 400);
    }
    if (intent === "remove_alt") {
      const removed = await removeDraftAltOf(db, user.id, id, { returnVersion: true, ...(browserDraft ? { expectedVersion: saved.version } : {}) });
      if (!removed.ok) return result(removed.error, true, saved.version, false, removed.error === "draft_conflict" ? 409 : 400);
      return result(null, true, removed.version ?? saved.version, true);
    }
    return result(null, true, saved.version);
  }
  catch (error) {
    if (!(error instanceof MarkdownBusyError) && !(error instanceof SigningFailureResponse)) throw error;
    const form = await retained.formData();
    const raw = readEntryForm(form);
    const values = { title: raw.title, body: raw.body, lang: raw.lang, asksStance: raw.asksStance, version: formString(form, "version"), signingView: formString(form, "signingView"), ...(villagesEnabled() ? { village: error instanceof SigningFailureResponse ? error.village ?? raw.village : raw.village } : {}) };
    return data({ error: error instanceof SigningFailureResponse ? error.code : "busy", saved: false, altRemoved: false, version: undefined, signingView: undefined, latest: null, values }, { status: error instanceof SigningFailureResponse ? error.status : 503, headers: error instanceof SigningFailureResponse ? { "Cache-Control": "private, no-store" } : { "Retry-After": "1" } });
  }

}

export function shouldRevalidate({ actionResult, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  // Keep this editor and its pasted candidate even if the saved draft is now gone.
  if (actionResult?.error === "draft_conflict" || actionResult?.error === "not_found") return false;
  return defaultShouldRevalidate;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.draft_title() }];
}

export const handle = { writing: true };


export default function DraftPage(props: Route.ComponentProps) {
  // The state of the form belongs to one draft: moving from one draft to another on the same screen starts the form again from that draft.
  return <DraftForm key={props.loaderData.draft.id} {...props} />;
}

function DraftForm({ loaderData, actionData }: Route.ComponentProps) {
  const originalDraft = useRef(loaderData.draft);
  const submitted = actionData?.values;
  const [draft, setDraft] = useState(() => {
    const initial = submitted ? { ...loaderData.draft, title: titleOrNull(submitted.title), body: submitted.body, asksStance: submitted.asksStance } : loaderData.draft;
    // Hydrating a nonempty textarea can restore its default over native edits.
    // Adopt those edits before React initializes the field; the guard and
    // autosave still compare with the original server text. Reloads and history
    // loads may instead restore stale input, so keep the server text there.
    const body = typeof document === "undefined" ? null : document.querySelector<HTMLTextAreaElement>(`form[action="/drafts/${initial.id}"] textarea[name="body"]`);
    const earlyBody = body ? prehydrationBody(body, (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type) : undefined;
    return earlyBody !== undefined ? { ...initial, body: earlyBody } : initial;
  });
  const [requiresReview] = useState(Boolean(draft.clientId || draft.via === "api"));
  const [version, setVersion] = useState(submitted ? Number(submitted.version) : draft.version);
  const [signingView, setSigningView] = useState(submitted ? submitted.signingView : loaderData.signingView);
  const [resolvedConflict, setResolvedConflict] = useState<typeof actionData>();
  const feedback = actionData === resolvedConflict ? undefined : actionData;
  const [editorRound, setEditorRound] = useState(0);
  const [candidate, setCandidate] = useState("");
  const [retained, setRetained] = useState<string | null>(null);
  const main = useRef<HTMLElement>(null);
  const lastAction = useRef(actionData);
  const browserDraft = draft.via === "web" && !requiresReview;
  // A first save from the new-topic screen comes here with ?saved=1: this screen says it was saved, and the mark is taken off the address a little later.
  const location = useLocation();
  const savedHere = useRef(new URLSearchParams(location.search).get("saved") === "1");
  useEffect(() => {
    if (!savedHere.current) return;
    const timer = setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("saved");
      window.history.replaceState(window.history.state, "", url);
    }, 5000);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!actionData || lastAction.current === actionData) return;
    lastAction.current = actionData;
    if (actionData.saved && actionData.version !== undefined && actionData.signingView) {
      setVersion(actionData.version);
      setSigningView(actionData.signingView);
      if ("village" in actionData) setDraft(current => ({ ...current, village: actionData.village }));
    }
    if (actionData.altRemoved) setDraft(current => ({ ...current, altOf: null, altTitle: null }));
  }, [actionData]);
  const [asksStance, setAsksStance] = useState(draft.asksStance);
  const [intro, setIntro] = useState(false);
  const guardDraft = editorRound > 0 || draft.id !== loaderData.draft.id ? draft : originalDraft.current;
  const error = feedback?.error ?? undefined;
  const errorText = feedback?.error ? (feedback.error === "draft_conflict" ? m.ai_write_conflict() : feedback.error === "not_found" ? m.ai_write_gone() : entryErrorMessage(feedback.error)) : undefined;
  // What follows the writing surface: how the last save or publish went, the newer saved version when another screen saved first, and the buttons.
  const status = <>
    {(savedHere.current && !feedback || feedback?.saved && !feedback.error) && <p role="status" className="text-success-foreground">{feedback?.altRemoved ? m.draft_alt_removed() : m.draft_saved()}</p>}
    {errorText && !(loaderData.posting && draft.kind === "topic" && isVillageTargetError(error)) && <p id="draft-error" role="alert" className="text-destructive">{errorText}</p>}
    {feedback?.latest && <div className="space-y-2 rounded border p-3">
      <a href={`/drafts/${draft.id}`} target="_blank" rel="noreferrer noopener" className="underline">{m.ai_write_latest()}</a>
      <details><summary>{m.ai_write_latest()}</summary>
        <p>{feedback.latest.draft.title}</p>
        <p>{feedback.latest.draft.lang}</p>
        <pre className="whitespace-pre-wrap break-words">{feedback.latest.draft.body}</pre>
      </details>
      <Button type="button" variant="outline" onClick={() => {
        const latest = feedback.latest!;
        setRetained(main.current?.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value ?? "");
        setDraft(latest.draft); setVersion(latest.draft.version); setSigningView(latest.signingView);
        setAsksStance(latest.draft.asksStance); setEditorRound(round => round + 1);
        setResolvedConflict(actionData);
      }}>{m.ai_write_use_latest()}</Button>
    </div>}
  </>;
  const buttons = <>
    {/* AI drafts require content review; optional signatures also review browser-authored drafts. */}
    <SendButton intent="publish">{m.draft_publish()}</SendButton>
    <noscript><SendButton variant="outline" intent="save" formNoValidate>{m.save_draft()}</SendButton></noscript>
    {/* Only alternative framings with unreadable originals may unlink. Save screen contents before removing the link. */}
    {draft.kind === "topic" && draft.altOf !== null && draft.altTitle === null && (
      <SendButton variant="outline" intent="remove_alt" formNoValidate>{m.draft_alt_remove()}</SendButton>
    )}
  </>;
  const ai = browserDraft && <AiEditorTools ownerId={loaderData.ownerId} connectDraftLabel={loaderData.connectDraftLabel} kind={draft.kind} threadId={draft.threadId ?? undefined} parentId={draft.parentId} draft={{ id: draft.id, version }} onSaved={saved => { setVersion(saved.version); setSigningView(saved.signingView); }} candidate={candidate} onCandidateChange={setCandidate} />;
  return (
    <main ref={main} className="space-y-4">
      <h1 className="text-xl font-bold">{m.draft_title()}</h1>
      {draft.via === "api" && (
        <div className="space-y-2 rounded border border-notice-border bg-notice-soft p-2 ui-help">
          <p>
            {m.draft_via_api()}
            {draft.tokenName && <> {m.draft_via_api_token({ name: draft.tokenName })}</>}
          </p>
          {draft.rawFrontmatter && (
            <details>
              <summary className="cursor-pointer">{m.draft_raw_frontmatter()}</summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs">{draft.rawFrontmatter}</pre>
            </details>
          )}
        </div>
      )}
      {draft.kind === "reply" && (
        <p className="ui-help text-muted-foreground">
          {draft.threadTitle ? (
            <Link to={`/t/${draft.threadId}`} className="underline">
              {m.draft_reply_to({ title: draft.threadTitle })}
            </Link>
          ) : (
            m.draft_thread_gone()
          )}
        </p>
      )}
      <SignedForm action={`/drafts/${draft.id}`} protectUnsaved="edit" unsavedInitialValues={{ title: guardDraft.title, body: guardDraft.body, lang: guardDraft.lang, asksStance: guardDraft.asksStance, stanceTag: guardDraft.stanceTag ?? "", village: guardDraft.village ?? loaderData.posting?.selected ?? "" }} key={editorRound} signatureRequired={loaderData.signPosts} confirmAiDraft={requiresReview} method="post" signIntent="publish" className="space-y-3">
        <input type="hidden" name="signingView" value={signingView} />
        {/* Approval fields must stay stable when lazy autosave connects during review. */}
        <input type="hidden" name="version" value={version} />
        {draft.kind === "topic" ? <TopicFields
          error={error} errorId="draft-error"
          BodyEditor={LongFormBody}
          autoLang={false}
          invalidatePreviewOnEdit={browserDraft}
          posting={loaderData.posting ? { data: loaderData.posting, selected: feedback?.values?.village ?? (editorRound > 0 ? draft.village : undefined) ?? loaderData.posting.selected, explicit: loaderData.posting.explicit, error: loaderData.posting.error ?? undefined } : undefined}
          keeper={{ owner: loaderData.ownerId, scope: `draft:${draft.id}`, startTitle: orBlank(guardDraft.title), startBody: guardDraft.body }}
          defaultLang={draft.lang}
          selectedLang={(editorRound === 0 ? submitted?.lang : undefined) || draft.lang}
          defaultTitle={orBlank(draft.title)}
          defaultBody={draft.body}
          asksStance={asksStance}
          onAsksStanceChange={setAsksStance}
          intro={intro}
          onIntroChange={setIntro}
          showIntro={false}
          altFixedNote={draft.altOf !== null ? <>
            {/* Alternative framing: the target is immutable and only shown. It must ask for stances, so the kind is fixed and submitted as a hidden field. */}
            <p>{draft.altTitle ? m.alt_of_label({ title: draft.altTitle }) : m.alt_of_origin_unreadable()}</p>
            {/* The original question is unreadable (hidden or deleted): explain why publication is blocked and provide the 「元の問いへのリンクを外す」 exit below. */}
            {draft.altTitle === null && <p role="status" className="rounded border border-notice-border bg-notice-soft p-2 ui-help text-notice-foreground">{m.draft_alt_origin_unreadable_help()}</p>}
          </> : undefined}
        >
          {status}
          <div className="flex flex-wrap items-center gap-3">{buttons}{ai}</div>
        </TopicFields> : <>
          <ReplyFields
            owner={loaderData.ownerId} threadId={draft.threadId ?? 0} keeper={{ scope: `draft:${draft.id}`, startBody: guardDraft.body }}
            error={error} errorId="draft-error" autoLang={false} invalidatePreviewOnEdit={browserDraft}
            defaultLang={draft.lang} selectedLang={(editorRound === 0 ? submitted?.lang : undefined) || draft.lang} defaultBody={draft.body}
            above={draft.threadAsksStance ? <StanceTagChips defaultValue={draft.stanceTag} /> : undefined}
            actions={buttons}
            aiTools={browserDraft ? { ownerId: loaderData.ownerId, connectDraftLabel: loaderData.connectDraftLabel, kind: draft.kind, threadId: draft.threadId ?? undefined, parentId: draft.parentId, draft: { id: draft.id, version }, onSaved: saved => { setVersion(saved.version); setSigningView(saved.signingView); }, candidate, onCandidateChange: setCandidate } : undefined}
          />
          {status}
        </>}
      <DraftAutosave owner={loaderData.ownerId} recoveryToken={loaderData.recoveryToken} scope={`draft:${draft.id}`} startTitle={orBlank(guardDraft.title)} startBody={guardDraft.body} draft={{ id: draft.id, version }} onSaved={saved => {
        setVersion(saved.version); setSigningView(saved.signingView);
        setResolvedConflict(actionData);
        if (saved.id !== draft.id) {
          setDraft(current => ({ ...current, id: saved.id, title: saved.title, body: saved.body, lang: saved.lang as typeof current.lang, asksStance: saved.asksStance, via: "web", tokenName: null, rawFrontmatter: null }));
          window.history.replaceState(window.history.state, "", `/drafts/${saved.id}`);
        }
      }} />
      </SignedForm>
      {retained !== null && <PersistentDetails open>
        <summary>{m.ai_write_retained()}</summary>
        <textarea aria-label={m.ai_write_retained()} readOnly value={retained} className="w-full rounded border p-2" rows={6} onFocus={e => e.currentTarget.select()} />
      </PersistentDetails>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Form
          action={`/drafts/${draft.id}`}
          method="post"
          onSubmit={(e) => {
            if (!window.confirm(m.draft_delete_confirm())) e.preventDefault();
            else window.dispatchEvent(new Event("tomola:discard-unsaved"));
          }}
        >
          <input type="hidden" name="intent" value="delete" />
          <Button variant="destructive" type="submit">
            {m.draft_delete()}
          </Button>
        </Form>
        {/* The plain-text version of the draft is a quiet link at the foot, not a fold at the head. */}
        {loaderData.posting && <Link to={`/drafts/${draft.id}.md`} reloadDocument className="ui-meta underline">{m.village_draft_markdown()}</Link>}
      </div>
    </main>
  );
}


// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
