import { inArray } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries } from "./db/schema";
import { figurePath, type FigureFallbackReason } from "./figure";
import { isEnabledLang } from "./enabled-langs.server";
import { availableFigures, type FigureDisplay } from "./figure-translation.server";
import { figureTranslationEnabled } from "./figure-reading.server";
import { siteUrl } from "./site-url";
import { mediaPath, parseMediaImage } from "./media";
import type { Lang } from "./languages";
import { m } from "~/paraglide/messages.js";

// Saved, sanitized HTML only. Tokenize complete tags so an apparent img inside a
// quoted title/alt or a comment is never interpreted as a separate image.
const tags = /<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
const attrs = /\s+([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function imageIn(tag: string) {
  if (!/^<img\b/i.test(tag)) return null;
  const attributes = [...tag.matchAll(attrs)];
  const src = attributes.find(attr => attr[1].toLowerCase() === "src");
  let origin: string | null = null;
  try { origin = new URL(siteUrl()).origin; } catch { /* Root-relative sources remain usable without a configured origin. */ }
  const image = src && parseMediaImage(src[2] ?? src[3] ?? src[4] ?? "", origin);
  return src && image ? { ...image, src } : null;
}
export function figureImageIds(html: string): string[] {
  return [...new Set([...html.matchAll(tags)].flatMap(match => { const image = imageIn(match[0]); return image ? [image.id] : []; }))];
}

export function decorateFigureHtml(html: string, originalHtml: string, available: ReadonlyMap<string, FigureDisplay>, lang: Lang): string {
  const originals = new Map<string, NonNullable<ReturnType<typeof imageIn>>[]>();
  for (const match of originalHtml.matchAll(tags)) {
    const image = imageIn(match[0]);
    if (image) originals.set(image.id, [...(originals.get(image.id) ?? []), image]);
  }
  const occurrences = new Map<string, number>();
  return html.replace(tags, raw => {
    const image = imageIn(raw);
    const index = image ? occurrences.get(image.id) ?? 0 : 0;
    if (image) occurrences.set(image.id, index + 1);
    const source = image && originals.get(image.id)?.[index];
    if (!image || !source || image.width !== source.width || image.height !== source.height) return raw;
    const original = mediaPath(image.id, image.width, image.height), translated = figurePath(image.id, image.width, image.height, lang);
    // Keep the displayed body's alt and other sanitized attributes, including
    // any translation made together with that body. Figure reading supplies no alt.
    const display = available.get(image.id);
    if (!display) return raw;
    const tag = display.hasImage ? raw.slice(0, image.src.index!) + ` src="${translated}"` + raw.slice(image.src.index! + image.src[0].length) : raw;
    const translatedLabel = `${m.figure_translated()} · ${m.figure_show_original()}`;
    const originalLabel = `${m.label_original()} · ${m.figure_show_translation()}`;
    const reasons: Record<FigureFallbackReason, () => string> = {
      does_not_fit: () => m.figure_fallback_space({}, { locale: lang }),
      math_mismatch: () => m.figure_fallback_math({}, { locale: lang }),
      font_missing: () => m.figure_fallback_font({}, { locale: lang }),
      unusable_reading: () => m.figure_fallback_reading({}, { locale: lang }),
      invalid_translation: () => m.figure_fallback_translation({}, { locale: lang }),
      image_too_large: () => m.figure_fallback_image({}, { locale: lang }),
    };
    const external = display.results.filter(r => r.status === "external" && r.reason && Object.hasOwn(reasons, r.reason));
    const items = external.map(result => {
      const translation = result.translation ?? m.figure_fallback_unavailable({}, { locale: lang });
      return `<span class="block mt-1" role="listitem"><span dir="auto">${escape(result.source)}</span> → <span lang="${lang}" dir="auto">${escape(translation)}</span><span class="block ui-meta">${escape(reasons[result.reason!]())}</span></span>`;
    }).join("");
    const allUnavailable = external.length === display.results.length && external.length > 0 && external.every(r => r.reason === "invalid_translation" && r.translation === null);
    const details = allUnavailable ? `<span class="block ui-meta">${escape(reasons.invalid_translation())}</span>` : `<span class="block" role="list">${items}</span>`;
    const heading = allUnavailable ? "" : `<span class="block font-semibold">${escape(m.figure_fallback_heading({}, { locale: lang }))}</span>`;
    const fallback = external.length ? `<span class="block mt-2 text-sm [overflow-wrap:anywhere]" data-figure-fallback role="note">${heading}${details}</span>` : "";
    const toggle = display.hasImage ? `<span class="block ui-meta"><a href="${original}" data-figure-toggle data-figure-source-label="${escape(translatedLabel)}" data-figure-translation-label="${escape(originalLabel)}">${escape(translatedLabel)}</a></span>` : "";
    return `<span class="inline-block max-w-full" data-translated-figure data-figure-original="${original}" data-figure-translated="${display.hasImage ? translated : original}">${tag}${toggle}${fallback}</span>`;
  });
}

export async function prepareEntryFigureDisplay(db: Db, ids: readonly number[], lang: Lang): Promise<(entryId: number, html: string) => string> {
  if (!figureTranslationEnabled() || !ids.length) return (_id, html) => html;
  const sources = await db.select({ id: entries.id, html: entries.html }).from(entries).where(inArray(entries.id, [...ids]));
  const originals = new Map(sources.map(source => [source.id, source.html ?? ""]));
  const available = await availableFigures(db, sources.flatMap(source => figureImageIds(source.html ?? "")), lang);
  return (id, html) => decorateFigureHtml(html, originals.get(id) ?? "", available, lang);
}

// Static document pages keep their ordinary database-free path when they contain
// no managed images, or when the feature is off. Their Markdown is unchanged.
export async function decorateDocumentFigures<T extends { introHtml: string; sections: { id: string; html: string }[] }>(page: T, original: () => Promise<T>, lang: string): Promise<T> {
  if (!figureTranslationEnabled() || !isEnabledLang(lang) || ![page.introHtml, ...page.sections.map(section => section.html)].some(html => figureImageIds(html).length)) return page;
  const source = await original();
  const { getDb } = await import("./db/client.server");
  const available = await availableFigures(await getDb(), [source.introHtml, ...source.sections.map(section => section.html)].flatMap(figureImageIds), lang);
  return { ...page, introHtml: decorateFigureHtml(page.introHtml, source.introHtml, available, lang), sections: page.sections.map(section => ({ ...section, html: decorateFigureHtml(section.html, source.sections.find(part => part.id === section.id)?.html ?? "", available, lang) })) };
}
