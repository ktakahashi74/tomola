import { DocumentHeader } from "~/components/document-header";
import { aiUsePage } from "~/lib/ai-use-page.server";
import { getLocale } from "~/paraglide/runtime.js";
import type { Route } from "./+types/ai-use";

export function loader() {
  return aiUsePage(getLocale());
}

export function headers() {
  return { "X-Robots-Tag": "noindex" };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: loaderData?.title ?? "tomola" },
    { name: "robots", content: "noindex" },
    { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/ai-use.md?lang=${loaderData?.locale ?? "en"}` },
  ];
}

export default function AiUse({ loaderData: page }: Route.ComponentProps) {
  return <>
    <DocumentHeader />
    <main className="reading-column space-y-8">
      <h1 className="reading-title">{page.title}</h1>
      <p>{page.opening} <a href="/connect" className="underline">{page.connectLabel}</a></p>
      <section aria-labelledby="ai-use-current" className="space-y-4">
        <h2 id="ai-use-current" className="text-lg font-semibold">{page.currentTitle}</h2>
        <p>{page.configNote}</p><p className="text-sm text-muted-foreground">{page.settingsNote}</p>
        <ul className="divide-y">
          {page.rows.map(row => <li key={row.purpose} data-ai-purpose={row.purpose} className="space-y-2 py-4">
            <h3 className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-semibold">{row.title}<span className="text-sm font-normal text-muted-foreground">{row.status}</span></h3>
            {row.enabled && <p className="text-sm">{row.provider} · <code className="break-all">{row.model}</code></p>}
            {row.settings.length > 0 && <p className="text-sm">{row.settings.join(" · ")}</p>}
            <p className="text-sm">{row.sent}</p>
            {row.unrecorded && <p role="note" className="text-sm text-notice-muted">{page.unrecorded}</p>}
          </li>)}
        </ul>
      </section>
      <section aria-labelledby="ai-use-search" className="space-y-2"><h2 id="ai-use-search" className="text-lg font-semibold">{page.searchTitle}</h2><p>{page.searchText}</p></section>
      <section aria-labelledby="ai-use-history" className="space-y-4">
        <h2 id="ai-use-history" className="text-lg font-semibold">{page.historyTitle}</h2>
        {page.history.length ? <ol className="space-y-4">{page.history.map((change, index) => <li key={`${change.purpose}-${change.date}-${index}`} className="space-y-1">
          <h3 className="font-semibold"><time dateTime={change.date}>{change.date}</time> · {change.title}</h3>
          <p className="break-all text-sm">{change.fromModel} → {change.toModel}</p>
          <p>{change.reason}</p>
          {change.evidenceUrl && <a href={change.evidenceUrl} className="underline">{page.evidenceLabel}</a>}
        </li>)}</ol> : <p>{page.noHistory}</p>}
      </section>
      <section aria-labelledby="ai-use-review" className="space-y-2"><h2 id="ai-use-review" className="text-lg font-semibold">{page.reviewTitle}</h2><p>{page.reviewText}</p></section>
      <section aria-labelledby="ai-use-objections" className="space-y-2">
        <h2 id="ai-use-objections" className="text-lg font-semibold">{page.objectionsTitle}</h2><p>{page.objectionsText}</p>
        {page.objectionsUrl && <a href={page.objectionsUrl} className="underline">{page.objectionsLabel}</a>}
      </section>
      <p className="flex flex-wrap gap-x-4 gap-y-2">{page.links.map(link => <a key={link.href} href={link.href} className="underline">{link.label}</a>)}</p>
    </main>
  </>;
}
