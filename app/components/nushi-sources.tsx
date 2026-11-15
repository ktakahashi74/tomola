import type { ReactNode } from "react";
import { m } from "~/paraglide/messages.js";

export type NushiSource = { author: string; date: string; href: string; quote: ReactNode };

export function NushiSources({ sources }: { sources: NushiSource[] }) {
  if (!sources.length) return null;
  return <div className="space-y-2">
    <p data-nushi-sources className="ui-meta">{m.nushi_sources()} {sources.map((source, index) => <span key={index}>{index > 0 && "、"}<a className="whitespace-nowrap underline" href={source.href}>{source.author} {source.date ? `${Number(source.date.slice(5, 7))}/${Number(source.date.slice(8, 10))}` : ""}</a></span>)}</p>
    <details data-nushi-quotes className="space-y-3 ui-help">
      <summary className="cursor-pointer underline">{m.nushi_quotes()}</summary>
      <ol className="space-y-3">{sources.map((source, index) => <li key={index}>
        <p className="ui-meta">[{index + 1}] {source.author} · {source.date}</p>
        {source.quote}
      </li>)}</ol>
    </details>
  </div>;
}
