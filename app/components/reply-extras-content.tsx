import { NushiComposerEntry } from "./nushi-composer-entry";
import { useState, type ComponentProps } from "react";
import { AiEditorTools, type AiEditorToolsProps } from "~/components/ai-editor-tools";
import { EntryLanguage } from "~/components/entry-language";
import { EntryPreview } from "~/components/entry-preview";
import { PersistentDetails } from "~/components/persistent-details";
import { PostSettings } from "~/components/post-settings";
import { FieldDescription } from "~/components/ui/field";
import { LANG_LABELS, isLang, type Lang, type SourceLang } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";

export type ReplyExtrasProps = { error?: string; errorId?: string; defaultLang: SourceLang; selectedLang?: string; autoLang: boolean; invalidatePreviewOnEdit: boolean; aiTools?: AiEditorToolsProps };

// What goes with the reply field beyond its button: the language (a line under the field, "Reply language: automatic · Change") and "…" with the preview, the writing help and writing with
// an AI. They need the page's scripts and are loaded after the page is ready (see reply-fields.tsx), so they are not part of the thread page's first script.
export default function ReplyExtrasContent({ error, errorId, defaultLang, selectedLang, autoLang, invalidatePreviewOnEdit, aiTools }: ReplyExtrasProps) {
  const [lang, setLang] = useState(selectedLang ?? (autoLang ? "" : defaultLang));
  const summary = lang === "" && autoLang ? m.reply_summary_lang_auto() : m.reply_summary_lang({ lang: (lang || defaultLang) === "other" ? m.source_language_other() : isLang(lang || defaultLang) ? LANG_LABELS[(lang || defaultLang) as Lang] : lang });
  return <>
    <NushiComposerEntry />
    <PostSettings summary={summary} open={error === "invalid_lang"}>
      <EntryLanguage error={error} errorId={errorId} defaultLang={defaultLang} value={lang === "" && !autoLang ? defaultLang : lang} onChange={setLang} pasteFrontmatter={autoLang} label={m.field_lang_reply()} />
    </PostSettings>
    {/* Opened, it takes a row of its own under the buttons. */}
    <PersistentDetails data-reply-more className="min-w-0 max-w-full open:w-full">
      <summary aria-label={m.reply_more()} className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg border px-2 text-muted-foreground [&::-webkit-details-marker]:hidden">…</summary>
      <div className="mt-2 space-y-3 rounded-lg border p-3">
        <EntryPreview kind="reply" pasteFrontmatter={autoLang ? "reply" : undefined} invalidateOnEdit={invalidatePreviewOnEdit} selectedLang={lang} />
        <div className="space-y-2 ui-help text-muted-foreground">
          <FieldDescription>{m.writing_math_help()}</FieldDescription>
          <FieldDescription><a href="/connect" target="_blank" rel="noreferrer" className="underline">{m.footer_connect()}</a></FieldDescription>
        </div>
        {aiTools && <AiEditorTools {...aiTools} />}
      </div>
    </PersistentDetails>
  </>;
}
