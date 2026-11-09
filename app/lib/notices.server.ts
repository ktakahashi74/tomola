import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import { previewLangs } from "~/lib/enabled-langs.server";
import type { Lang } from "~/lib/languages";
import { noticeSources, noticesAvailable, type NoticeKind } from "~/lib/notice-sources.server";
export { noticesAvailable, trialParticipationRequired, type NoticeKind, type NoticeSources } from "~/lib/notice-sources.server";
import { renderMarkdown } from "~/lib/markdown.server";

export function footerNotices(locale: Lang = getLocale(), previews: readonly Lang[] = previewLangs()) {
  return { previewNotice: previews.includes(locale) ? m.ui_preview_notice({}, { locale }) : null, privacyLabel: noticesAvailable().privacy ? m.footer_privacy({}, { locale }) : null, statsLabel: m.stats_title({}, { locale }) };
}
export function parseNotice(markdown: string) {
  const [heading, ...lines] = markdown.split(/\r?\n/);
  if (!heading.startsWith("# ")) throw new Error("A notice must start with a title");
  const starts = lines.flatMap((line, i) => { const match = /^## (\d+)\. /.exec(line); return match ? [{ index: i, id: `s${match[1]}` }] : []; });
  return { title: heading.slice(2), intro: lines.slice(0, starts[0]?.index ?? lines.length).join("\n").trim(), sections: starts.map((section, i) => ({ id: section.id, markdown: lines.slice(section.index, starts[i + 1]?.index ?? lines.length).join("\n").trim() })) };
}
export function noticeFor(kind: NoticeKind, requested: string, texts = noticeSources(kind)) {
  const lang = requested === "ja" ? "ja" : "en";
  return { kind, requested, lang, fallback: lang !== requested, markdown: texts[lang], ...parseNotice(texts[lang]) };
}
const rendered = new Map<string, Promise<{ introHtml: string; sections: Array<{ id: string; html: string }> }>>();
export function renderNotice(doc: ReturnType<typeof noticeFor>) {
  const key = `${doc.kind}:${doc.lang}:${doc.markdown}`;
  let result = rendered.get(key);
  if (!result) {
    result = (async () => ({ introHtml: await renderMarkdown(doc.intro, { lang: doc.lang }), sections: await Promise.all(doc.sections.map(async section => ({ id: section.id, html: await renderMarkdown(section.markdown, { lang: doc.lang }) }))) }))();
    rendered.set(key, result);
    result.catch(() => rendered.delete(key));
  }
  return result;
}
