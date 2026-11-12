import { useEffect } from "react";
import { useLocation } from "react-router";
import type { Lang, SourceLang } from "~/lib/languages";
import { SHARE_LANG_PARAM } from "~/lib/share-language";

// Follow the body version without navigation, revalidation or a new history entry.
export function ShareCardAddress({ topicId, originalLang, readingLang }: { topicId: number; originalLang: SourceLang; readingLang: SourceLang }) {
  const location = useLocation();
  useEffect(() => {
    const url = new URL(window.location.href);
    // A previous page's effect must never annotate the destination of a navigation.
    if (url.pathname !== `/t/${topicId}` || url.pathname !== location.pathname) return;
    if (url.searchParams.has("lang") || readingLang === originalLang) url.searchParams.delete(SHARE_LANG_PARAM);
    else url.searchParams.set(SHARE_LANG_PARAM, readingLang);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [topicId, originalLang, readingLang, location.pathname, location.search, location.key]);
  return null;
}
