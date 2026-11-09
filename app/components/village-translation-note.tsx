import { Link, useLocation } from "react-router";
import { languageLabel } from "~/lib/language-label";
import type { VillageTranslationInfo } from "~/lib/village-translation-view";
import { m } from "~/paraglide/messages.js";

// Under a translated village name and description: the source language and the original/translation switch. The choice is in the address (?vorig=1),
// so the link works without JavaScript and can be shared.
export const VILLAGE_ORIGINAL_PARAM = "vorig";
export function VillageTranslationNote({ info }: { info: VillageTranslationInfo }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  if (info.shown) params.set(VILLAGE_ORIGINAL_PARAM, "1"); else params.delete(VILLAGE_ORIGINAL_PARAM);
  const search = params.toString();
  const from = languageLabel(info.from);
  return <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 ui-meta text-muted-foreground">
    <span>{info.shown ? m.label_from_lang_machine({ lang: from }) : m.reading_lang_original({ name: from })}</span>
    {" "}
    <Link to={`${location.pathname}${search ? `?${search}` : ""}`} rel="nofollow" preventScrollReset className="link-ui">{info.shown ? m.show_original() : m.show_translation()}</Link>
  </p>;
}
