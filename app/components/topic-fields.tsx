import { TitledMessage } from "~/components/titled-message";
import { MediaInsert, MediaInsertHelp } from "~/components/media-insert";
import { FieldLabel } from "~/components/ui/field";
import { Checkbox } from "~/components/ui/checkbox";
import { useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { EntryFields, EntryLanguage, type BodyEditorProps } from "~/components/entry-fields";
import { TitleField } from "~/components/title-field";
import { PostSettings } from "~/components/post-settings";
import { VillageTarget } from "~/components/village-target";
import { DraftKeeper } from "~/components/draft-keeper";
import type { PostingVillages } from "~/lib/villages.server";
import { LANG_LABELS, isLang, type Lang, type SourceLang } from "~/lib/languages";
import { startsWithFrontmatter } from "~/lib/text";
import { m } from "~/paraglide/messages.js";

// The writing surface shared by new topics and drafts: destination, title,
// question and introduction options, body, then language settings. `children` are the route's own buttons.
// The keyed body stays mounted when the options move, preserving native editing history and input-method composition.
export function TopicFields({ defaultLang, defaultTitle = "", defaultBody = "", selectedLang = "", autoLang = true, asksStance, onAsksStanceChange, intro, onIntroChange, showIntro, alt, altNotFound, altFixedNote, sharePrefilled, BodyEditor, posting, invalidatePreviewOnEdit = false, keeper, notices, error, errorId, children }: {
  error?: string;
  errorId?: string;
  defaultLang: SourceLang;
  defaultTitle?: string;
  defaultBody?: string;
  selectedLang?: string;
  // The language starts as "automatic" (detected from the text) on a new topic; a saved draft has a language of its own.
  autoLang?: boolean;
  asksStance: boolean;
  onAsksStanceChange: (checked: boolean) => void;
  intro: boolean;
  onIntroChange: (checked: boolean) => void;
  showIntro: boolean;
  alt?: { id: number; title: string; titleLang: string } | null;
  altNotFound?: boolean;
  // Shown when the topic is fixed to be a question (an alternative framing); the draft screen adds the unreadable-original help.
  altFixedNote?: ReactNode;
  sharePrefilled?: boolean;
  BodyEditor?: ComponentType<BodyEditorProps>;
  posting?: { data: PostingVillages; selected: string; explicit: boolean; error?: string; reviewedBody?: string; reset?: number };
  invalidatePreviewOnEdit?: boolean;
  // owner and scope name the local record; start* is the text the screen starts from (the prefill, or the saved draft), not what a refused form shows again.
  keeper?: { owner: string; scope: string; startTitle?: string; startBody: string };
  notices?: ReactNode;
  children?: ReactNode;
}) {
  const titleInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(defaultTitle);
  const [lang, setLang] = useState(selectedLang);
  const [pasted, setPasted] = useState(startsWithFrontmatter(defaultBody));
  // Hydration preserves native edits but does not copy them into controlled state.
  // Adopt them before the first client rerender or the form's ready marker.
  useLayoutEffect(() => {
    const input = titleInput.current;
    if (!input) return;
    setTitle(input.value);
    const body = input.form?.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
    if (body) setPasted(startsWithFrontmatter(body.value));
    const stance = input.form?.querySelector<HTMLInputElement>('input[name="asksStance"]');
    const introduction = input.form?.querySelector<HTMLInputElement>('input[name="intro"]');
    if (stance) onAsksStanceChange(stance.type === "checkbox" ? stance.checked : stance.value === "1");
    if (introduction?.type === "checkbox") onIntroChange(introduction.checked);
  }, []);
  const titleNeeded = asksStance || Boolean(alt);
  const fixedQuestion = Boolean(alt) || altFixedNote !== undefined;
  const summary = lang === "" && autoLang ? m.post_summary_lang_auto() : m.post_summary_lang({ lang: (lang || defaultLang) === "other" ? m.source_language_other() : isLang(lang || defaultLang) ? LANG_LABELS[(lang || defaultLang) as Lang] : lang });
  return <>
    {notices}
    {keeper && <DraftKeeper {...keeper} />}
    <div key="heading" className="space-y-3">
      {fixedQuestion && <div className="space-y-1">
        {alt && <p><TitledMessage message={m.alt_of_label({ title: "{title}" })} title={alt.title} lang={alt.titleLang} /></p>}
        {alt && <input type="hidden" name="altOf" value={alt.id} />}
        <input type="hidden" name="asksStance" value="1" />
        <p className="ui-help text-muted-foreground">{m.asks_stance_alt_fixed()}</p>
        {altFixedNote}
      </div>}
      {altNotFound && <p role="status" className="ui-help text-notice-foreground">{m.alt_of_not_found()}</p>}
      {posting && <VillageTarget key={posting.reset} error={error ?? posting.error} posting={posting.data} selected={posting.selected} explicitSelection={posting.explicit} reviewedBody={posting.reviewedBody} frontmatter={autoLang} />}
      <TitleField error={error} errorId={errorId} ref={titleInput} value={title} onChange={e => setTitle(e.target.value)} required={titleNeeded && !pasted} mustHave={titleNeeded} />
      {!fixedQuestion && <div className="flex flex-wrap gap-x-4 gap-y-2">
        <FieldLabel>
          <Checkbox name="asksStance" value="1" checked={asksStance} onCheckedChange={checked => { onAsksStanceChange(checked); if (checked) onIntroChange(false); }} /> {m.asks_stance_checkbox()}
        </FieldLabel>
        {showIntro && <FieldLabel>
          <Checkbox name="intro" value="1" checked={intro} onCheckedChange={checked => { onIntroChange(checked); if (checked) onAsksStanceChange(false); }} /> {m.intro_checkbox()}
        </FieldLabel>}
      </div>}
      {sharePrefilled && <p role="status" className="ui-help text-muted-foreground">{m.share_prefill_notice()}</p>}
    </div>
    <EntryFields error={error} errorId={errorId} key="body" defaultLang={defaultLang} defaultBody={defaultBody} pasteFrontmatter={autoLang ? "topic" : undefined} onBodyInput={value => setPasted(startsWithFrontmatter(value))} showLanguage={false} rows={12} tall
      bodyPlaceholder={asksStance || alt ? m.field_body_placeholder_question() : m.field_body_placeholder_topic()} invalidatePreviewOnEdit={invalidatePreviewOnEdit} previewLanguage={lang}
      writingHelp={<MediaInsertHelp />} bodyAccessory={<MediaInsert compact />} BodyEditor={BodyEditor} editorLang={lang || defaultLang} />
    <div className="space-y-2">
      <PostSettings summary={summary} open={error === "invalid_lang"}>
        <EntryLanguage error={error} errorId={errorId} defaultLang={defaultLang} value={lang === "" && !autoLang ? defaultLang : lang} onChange={setLang} pasteFrontmatter={autoLang} />
      </PostSettings>
      {(asksStance || alt) && <p className="ui-help text-muted-foreground">{m.asks_stance_help()}</p>}
    </div>
    {children}
  </>;
}
