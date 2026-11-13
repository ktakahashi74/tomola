import { preparePostAiMaterial, writePostAiMaterial } from "~/lib/post-ai-materials.server";
import { POST_AI_MATERIAL_CHARS } from "~/lib/post-ai-materials";
import { Textarea } from "~/components/ui/textarea";
import { MarkdownBusyError, withMarkdownRead } from "~/lib/markdown-budget.server";
import { LongFormBody } from "~/components/long-form-body";
import { useContext, useEffect, useRef, useState } from "react";
import { DraftAutosave } from "~/components/draft-autosave-lazy";
import DraftKeeperContent, { type DraftKeeperProps } from "~/components/draft-keeper-content";
import { FormLanguageChangeContext } from "~/components/form-contexts";
import { data, Link, redirect, useLocation } from "react-router";
import type { Route } from "./+types/topic-new";
import { entryErrorMessage } from "~/components/entry-fields";
import { TopicFields } from "~/components/topic-fields";
import { isVillageTargetError } from "~/components/village-target";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { displayLangFor, villageReaderFor } from "~/lib/display-lang.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { glossaryProposalPrefill } from "~/lib/glossary-proposal.server";
import { defaultPostLang } from "~/lib/profiles.server";
import { loadAltOrigin } from "~/lib/objections.server";
import { parseIdOrNull } from "~/lib/params.server";
import { ownTopicDraftIds, createDraft, deleteLinkedDraft, linkedDraftOf, updateDraft } from "~/lib/drafts.server";
import { applyPastedFrontmatter, formString, readEntryForm, submitTopicForm } from "~/lib/entry-form.server";
import { DRAFT_RATE_LIMIT, hitRateLimit, hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { postedLocation } from "~/lib/posted-ui";
import { m } from "~/paraglide/messages.js";
import { SigningFailureResponse, withSignedWrite } from "~/lib/signing.server";
import { SignedForm, SendButton } from "~/components/signed-form";
import { baseOf, orBlank, type LocalDraft } from "~/lib/local-draft";
import { newPostDraftStore } from "~/lib/new-post-draft";
import { sharePrefill } from "~/lib/share-prefill";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { AiEditorTools } from "~/components/ai-editor-tools";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { postingVillages } from "~/lib/villages.server";
import { isSharedVillageKind } from "~/lib/villages";
import { responsePostId, responsePostPrefill } from "~/lib/response-post.server";
import { getLocale } from "~/paraglide/runtime.js";

// ?asks_stance=1 preselects 「立場を聞く」. ?alt_of=<id> creates an alternative-framing question; accept only an undeleted, unhidden original question.
// If invalid, clear the alternative-framing selection and show 「元の問いが見つかりません」. Alternative-framing questions always ask for stances.
async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { profile, db, user } = await requireMember(request);
  const params = new URL(request.url).searchParams;
  const altParam = params.get("alt_of");
  const altId = altParam === null ? null : parseIdOrNull(altParam);
  const origin = altId === null ? null : await loadAltOrigin(db, altId, { readLangs: profile.readLangs, displayLang: displayLangFor(request, profile) });
  const defaultLang = defaultPostLang(profile);
  // Translation-term proposal template (?propose_term=1 from the glossary). If alt_of is also supplied, prioritize it and omit the template. Write the template in the default posting language.
  const proposal = altParam === null ? await glossaryProposalPrefill(db, params, { locale: defaultLang, enabled: enabledLangs() }) : null;
  const shared = altParam === null && !params.has("propose_term") ? sharePrefill(params) : null;
  const responseParam = altParam === null && !params.has("propose_term") && !shared ? params.get("respond") : null;
  const response = await responsePostPrefill(db, responseParam, getLocale());
  const responseTo = responsePostId(params);
  const prefill = proposal ?? shared ?? response?.prefill ?? null;
  const intro = origin === null && proposal === null && params.get("asks_stance") !== "1" && params.get("intro") === "1";
  const posting = villagesEnabled() ? await postingVillages(db, user.id, params.get("village"), { reader: villageReaderFor(request, profile) }) : undefined;
  if (posting && response?.village) {
    const index = posting.choices.findIndex(choice => choice.slug === response.village);
    if (index > 0) posting.choices.unshift(...posting.choices.splice(index, 1));
    const source = posting.choices.find(choice => choice.slug === response.village);
    if (!params.has("village") && source && isSharedVillageKind(source.kind)) {
      posting.selected = source.slug!;
      // Carry this contextual destination through saves and publication rather
      // than resolving the member's usual default again on submission.
      posting.explicit = true;
      posting.error = null;
    }
  }
  return {
    ownerId: user.id,
    connectDraftLabel: m.connect_draft_link(),
    // Unfinished topics the member has saved: offered as a link above the form.
    draftIds: await ownTopicDraftIds(db, user.id),
    ...(posting ? { posting } : {}),
    defaultLang,
    signPosts: profile.signPosts,
    prefill,
    formKey: prefill ? `${prefill.title}\n${prefill.body}` : "plain",
    initialValues: { title: prefill?.title, body: prefill?.body },
    draftStart: { startTitle: orBlank(prefill?.title), startBody: orBlank(prefill?.body) },
    // Each arrival keeps its own unsent writing, including after a source changes.
    draftScope: ["topic-new", responseTo === null ? (prefill ? baseOf(prefill.title, orBlank(prefill.body)) : "") : `respond:${responseTo}`, origin?.id ?? "", intro ? "intro" : ""].join(":"),
    responseField: { name: "responseTo", value: responseTo ?? "" },
    responsePlaceHint: posting && response ? m.response_post_place_hint() : null,
    newDraftAction: `/t/new?${new URLSearchParams({ ...Object.fromEntries(params), newdraft: "1" })}`,
    showIntro: params.get("intro") === "1",
    sharePrefilled: shared !== null,
    asksStance: origin !== null || proposal !== null || params.get("asks_stance") === "1",
    intro,
    // Alternative framing: original question id and display title. Set altNotFound when a supplied target is unreadable.
    alt: origin ? { id: origin.id, title: origin.title.text, titleLang: origin.title.lang } : null,
    altNotFound: altParam !== null && origin === null,
  };
}

export async function action({ request }: Route.ActionArgs) {

  const retained = request.clone();
  try {
    assertSameOrigin(request);
    const { user, db, profile } = await requireWriter(request);
    const form = await request.formData();
    // Reads the frontmatter pasted at the top of the body (title, language, ai_assistance if present). A value typed in the form wins over the frontmatter (entry-form.server.ts); the form has no ai_assistance field.
    const raw = readEntryForm(form);
    // A question without its title is refused with invalid_title, and so is a post that went over the limit. What was written is handed back then, so that the form is drawn as it was even without
    // JavaScript: the title and the body, and also "ask for stances" and the language, which cannot be changed after posting (a re-render with the defaults would post a non-question
    // in the default language). The language is "" for "automatic".
    const values = { aiMaterial: formString(form, "aiMaterial"), title: raw.title, body: raw.body, asksStance: raw.asksStance, lang: raw.lang, intro: formString(form, "intro") === "1", ...(villagesEnabled() ? { village: raw.village, villageExplicit: raw.villageExplicit } : {}) };
    if (formString(form, "intent") === "respond") {
      const response = await responsePostPrefill(db, String(responsePostId(new URL(request.url).searchParams) ?? ""), getLocale());
      // Carry the complete reply by POST, including empty writing, without
      // publishing it or putting its text in the address. Keep the reply copy.
      return data({ error: null, values: { ...values, village: undefined, villageExplicit: undefined, title: "", body: (response?.prefill.body ?? "") + raw.body, asksStance: false, intro: false } });
    }
    const fail = (error: string, village?: string) => data({ error, values: { ...values, ...(village === undefined ? {} : { village }) } }, { status: 400 });
    const supplement = formString(form, "aiMaterial");
    if (supplement.trim() && (!preparePostAiMaterial(supplement) || formString(form, "intent") === "draft")) return fail("ai_material_invalid");
    if (formString(form, "intent") === "draft") {
      const rate = await hitRateLimit(db, { key: `draft:member:${user.id}`, ...DRAFT_RATE_LIMIT });
      if (!rate.allowed) return data({ error: "rate_limited", values }, { status: 429, headers: rateLimitHeaders(rate) });
      const pasted = (await applyPastedFrontmatter(raw, "topic", { defaultLang: defaultPostLang(profile), allowComplex: formString(form, "intent") === "draft" }));
      if (!pasted.ok) return fail(pasted.error);
      // A draft that "Write with AI" made from this screen is updated in place (at the version this screen saw), not copied: an AI may have changed it since.
      // After a conflict, "save as a new draft" asks for a copy of what is on the screen instead.
      const linked = new URL(request.url).searchParams.get("newdraft") === "1" ? null : linkedDraftOf(form);
      if (linked) {
        const updated = await updateDraft(db, user.id, linked.id, pasted.input, { expectedVersion: linked.version });
        if (updated.ok) throw redirect(`/drafts/${linked.id}?saved=1`);
        if (updated.error === "draft_conflict") return data({ error: "draft_conflict", values }, { status: 409 });
        if (updated.error !== "not_found") return fail(updated.error);
      }
      const draft = await createDraft(db, user.id, { kind: "topic", ...pasted.input }, { responseTo: responsePostId(new URL(request.url).searchParams) });
      if (draft.ok) {
        // The draft screen says it was saved (it is a screen of its own, and a first save is not otherwise told).
        throw redirect(`/drafts/${draft.id}?saved=1`);
      }
      return fail(draft.error);
    }
    // Publishing counts against the topic limit; saving a draft does not.
    const rate = await hitMemberLimit(db, "topic", user.id);
    if (!rate.allowed) return data({ error: "rate_limited", values }, { status: 429, headers: rateLimitHeaders(rate) });
    // The draft that "Write with AI" made is removed in the same transaction, so that a failure here cannot leave a post made and the form still sendable.
    const res = await withSignedWrite(db, user.id, request, form, async tx => {
      const posted = await submitTopicForm(tx, { user, profile }, form, { responseTo: responsePostId(new URL(request.url).searchParams) });
      if (posted.ok && supplement.trim()) {
        const saved = await writePostAiMaterial(tx, user.id, posted.id, { body: supplement, version: 0 });
        if (!saved.ok) throw new Error("Supplement could not be saved");
      }
      if (posted.ok) await deleteLinkedDraft(tx, user.id, form);
      return posted;
    });
    if (res.ok) {
      throw redirect(supplement.trim() ? `/t/${res.id}/ai-materials/edit?saved=1` : postedLocation(`/t/${res.id}`, res.id));
    }
    return fail(res.error, res.village);
  }
  catch (error) {
    if (!(error instanceof MarkdownBusyError) && !(error instanceof SigningFailureResponse)) throw error;
    const form = await retained.formData();
    const raw = readEntryForm(form);
    const values = { aiMaterial: formString(form, "aiMaterial"), title: raw.title, body: raw.body, asksStance: raw.asksStance, lang: raw.lang, intro: formString(form, "intro") === "1", ...(villagesEnabled() ? { village: error instanceof SigningFailureResponse ? error.village ?? raw.village : raw.village, villageExplicit: raw.villageExplicit } : {}) };
    return data({ error: error instanceof SigningFailureResponse ? error.code : "busy", values }, { status: error instanceof SigningFailureResponse ? error.status : 503, headers: error instanceof SigningFailureResponse ? { "Cache-Control": "private, no-store" } : { "Retry-After": "1" } });
  }

}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.topic_new_title() }];
}

export default function TopicNew(props: Route.ComponentProps) {
  // The state of the form (the "ask for stances" box, whether the body starts with pasted frontmatter) belongs to one address of this page: when the member goes from /t/new to
  // /t/new?asks_stance=1 (or the other way) on the same screen, the form starts again from what that address says, not from the state of the earlier one. A refused post stays at the
  // same address, so the form keeps what was typed.
  const location = useLocation();
  const entry = useRef(location.key);
  const previous = useRef(location);
  if (location.key !== previous.current.key) {
    if (!props.actionData && (!location.hash || location.hash === previous.current.hash)) entry.current = location.key;
    previous.current = location;
  }
  return <TopicNewForm key={`${props.loaderData.ownerId}:${location.pathname}${location.search}:${entry.current}`} {...props} />;
}

function NewTopicDraftKeeper(props: DraftKeeperProps) {
  const language = useContext(FormLanguageChangeContext);
  return <DraftKeeperContent {...props} onLanguageChange={lang => language?.current?.(lang)} />;
}

// The writing screens are marked so that the page frame can be quiet around them (the frame's own change is made elsewhere).
export const handle = { writing: true };


function TopicNewForm({ loaderData, actionData }: Route.ComponentProps) {
  const location = useLocation();
  const screen = loaderData.draftScope;
  const [store, setStore] = useState<ReturnType<typeof newPostDraftStore>>();
  const [recovery, setRecovery] = useState<{ record: LocalDraft | null; round: number }>();
  useEffect(() => { setStore(newPostDraftStore(loaderData.ownerId, screen)); }, [loaderData.ownerId, screen]);
  useEffect(() => { store?.remember(); }, [store, location.key]);
  const [linkedId, setLinkedId] = useState<number>();
  const [restoredPosting, setRestoredPosting] = useState<{ village: string; explicit: boolean }>();
  const [discarded, setDiscarded] = useState(0);
  const draftCount = loaderData.draftIds.filter(id => id !== linkedId).length;
  // The title is optional, except for a question ("ask for stances", or an alternative framing, which is always a question).
  const [asksStance, setAsksStance] = useState(actionData?.values?.asksStance ?? loaderData.asksStance);
  const [intro, setIntro] = useState(actionData?.values?.intro ?? loaderData.intro);
  const error = actionData?.error ?? loaderData.posting?.error ?? undefined;
  const posting = loaderData.posting ? { data: loaderData.posting, reset: discarded, selected: actionData?.values?.village ?? (restoredPosting?.explicit ? restoredPosting.village : loaderData.posting.selected), explicit: actionData?.values?.villageExplicit ?? restoredPosting?.explicit ?? loaderData.posting.explicit, error: actionData?.error ?? loaderData.posting.error ?? undefined, reviewedBody: actionData?.error === "village_changed" ? actionData.values?.body : undefined } : undefined;
  return (
    <main className="space-y-4">
      <h1 className="text-xl font-bold">{m.topic_new_title()}</h1>
      {draftCount > 0 && <p className="ui-meta"><Link to="/drafts" className="underline">{m.drafts_resume({ count: draftCount })}</Link></p>}
      <SignedForm protectUnsaved="new" unsavedInitialValues={loaderData.initialValues} signatureRequired={loaderData.signPosts} method="post" key={loaderData.formKey} className="group/compose space-y-3">
        <input type="hidden" {...loaderData.responseField} />
        {store && <NewTopicDraftKeeper owner={loaderData.ownerId} scope={screen} store={store} onRecovery={record => setRecovery(current => ({ record, round: (current?.round ?? 0) + 1 }))} onDiscard={fields => {
          setAsksStance(fields.get("asksStance") === "1");
          setIntro(fields.get("intro") === "1");
          setRestoredPosting({ village: String(fields.get("village") ?? ""), explicit: fields.get("villageExplicit") === "1" });
          setDiscarded(round => round + 1);
        }} {...loaderData.draftStart} />}
        <TopicFields
          error={actionData?.error ?? undefined} errorId="topic-new-error"
          BodyEditor={LongFormBody}
          posting={posting}
          notices={loaderData.responsePlaceHint && <p className="ui-help text-muted-foreground">{loaderData.responsePlaceHint}</p>}
          defaultLang={loaderData.defaultLang}
          defaultTitle={actionData?.values?.title ?? loaderData.prefill?.title}
          defaultBody={actionData?.values?.body ?? loaderData.prefill?.body}
          selectedLang={actionData?.values?.lang}
          asksStance={asksStance}
          onAsksStanceChange={setAsksStance}
          intro={intro}
          onIntroChange={setIntro}
          showIntro={loaderData.showIntro || actionData?.values?.intro === true}
          alt={loaderData.alt}
          altNotFound={loaderData.altNotFound}
          sharePrefilled={loaderData.sharePrefilled}
        >
          <details open={!!actionData?.values?.aiMaterial}><summary className="ui-meta">{m.ai_material_add()}</summary>
            <label className="block" htmlFor="new-ai-material">{m.ai_material_title()}</label>
            <Textarea id="new-ai-material" name="aiMaterial" rows={8} maxLength={POST_AI_MATERIAL_CHARS} defaultValue={actionData?.values?.aiMaterial ?? ""} />
            <p className="ui-help">{m.ai_material_input_help({ count: POST_AI_MATERIAL_CHARS })}</p>
          </details>
          {error && !(posting && isVillageTargetError(error)) && <p id="topic-new-error" role="alert" className="text-destructive">{error === "ai_material_invalid" ? m.ai_material_error() : entryErrorMessage(error)}</p>}
          <div className="flex flex-wrap items-center gap-3">
            {/* The first 「投稿」 button is the default for Enter submission. */}
            <SendButton>{m.submit_post()}</SendButton>
            <noscript><SendButton variant="outline" intent="draft" formNoValidate>{m.save_draft()}</SendButton>
            {error === "draft_conflict" && <SendButton variant="outline" intent="draft" formAction={loaderData.newDraftAction} formNoValidate>{m.save_draft_as_new()}</SendButton>}</noscript>
            {!intro && <AiEditorTools ownerId={loaderData.ownerId} connectDraftLabel={loaderData.connectDraftLabel} kind="topic" />}
          </div>
          {store && recovery && <DraftAutosave key={recovery.round} recovered={recovery.record} owner={loaderData.ownerId} scope={screen} store={store} {...loaderData.draftStart} newTopic onLinked={setLinkedId} onRestore={fields => {
            setAsksStance(fields.get("asksStance") === "1");
            setIntro(fields.get("intro") === "1");
            setRestoredPosting({ village: String(fields.get("village") ?? ""), explicit: fields.get("villageExplicit") === "1" });
          }} />}
        </TopicFields>
      </SignedForm>
    </main>
  );
}


// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
