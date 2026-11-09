import { Link, useLocation } from "react-router";
import { LANG_LABELS, type Lang } from "~/lib/languages";
import { originalLanguagePath } from "~/lib/navigation";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { m } from "~/paraglide/messages.js";

export function OriginalLanguageFilter({ lang = null }: { lang?: Lang | null }) {
  const location = useLocation();
  const langs = useEnabledLangs();
  const item = (target: Lang | null, label: string) => <Link key={target ?? "all"} to={originalLanguagePath(location.search, target)} lang={target ?? undefined} aria-current={target === lang ? "page" : undefined} className="choice">{label}</Link>;
  return <nav aria-label={m.home_origlang_label()} className="flex flex-wrap items-center gap-x-4 gap-y-1 ui-meta">
    {item(null, m.home_filter_all())}
    {langs.map(target => item(target, LANG_LABELS[target]))}
  </nav>;
}
