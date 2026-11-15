import type { ReactNode } from "react";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

export type NushiSource = { author: string; date: string; href: string; quote: ReactNode; left?: boolean };
export const NUSHI_READINGS_FOLD_CHARS = 2200;

export function nushiSourceLabel(source: Pick<NushiSource, "author" | "date">) {
  const date = source.date && new Intl.DateTimeFormat(getLocale(), { month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date(`${source.date}T00:00:00Z`));
  return [source.author, date].filter(Boolean).join(" ");
}

export function NushiSources({ sources, tabIndex }: { sources: NushiSource[]; tabIndex?: number }) {
  if (!sources.length) return null;
  const locale = getLocale(), labels = sources.map(source => nushiSourceLabel(source) + (source.left ? ` · ${m.nushi_left()}` : ""));
  let index = 0;
  return <div className="space-y-2">
    <p data-nushi-sources className="ui-meta">{m.nushi_sources()}{/^(ja|zh)(-|$)/.test(locale) ? "" : " "}{new Intl.ListFormat(locale, { type: "conjunction", style: "narrow" }).formatToParts(labels).map((part, key) => part.type === "element"
      ? <a key={key} tabIndex={tabIndex} className="whitespace-nowrap underline" href={sources[index++].href}>{part.value}</a> : part.value)}</p>
    <details data-nushi-quotes className="space-y-3 ui-help">
      <summary tabIndex={tabIndex} className="cursor-pointer underline">{m.nushi_quotes()}</summary>
      <ol className="space-y-3">{sources.map((source, index) => <li key={index}>
        <p className="ui-meta">[{index + 1}] {source.author} · {source.date}</p>
        {source.quote}
      </li>)}</ol>
    </details>
  </div>;
}
