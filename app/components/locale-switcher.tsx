import { useShellLabels } from "~/lib/use-shell-labels";
import { Link } from "react-router";
import { Globe } from "lucide-react";
import { selectUiLocale } from "~/lib/http/locale-selection";
import { LANG_LABELS } from "~/lib/languages";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { getLocale } from "~/paraglide/runtime.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";

// The interface language switcher: enabled languages by their own names, followed by a link to request another language.
// The names are data (LANG_LABELS), not messages, and follow the order of LANGS.
// Only an explicit choice writes the cookie and reloads; the server reads the cookie and decides the language (app/lib/http/locale.server.ts).
// `globe`: draw a globe before the name, so that a bare language name in a header reads as the language of the screen (and not of the posts).
// `clearReadingLanguage`: the guest header's choice also clears a page's reading override so posts follow the screen language.
export function LocaleSwitcher(props: { "aria-label"?: string; globe?: boolean; clearReadingLanguage?: boolean } = {}) {
  const labels = useShellLabels();
  const langs = useEnabledLangs();
  const locale = getLocale();
  return (
    <Select
      value={locale}
      onValueChange={(value) => {
        if (value) selectUiLocale(value, langs, props);
      }}
    >
      <SelectTrigger className="locale-trigger" aria-label={props["aria-label"] ?? labels.language_select}>
        {props.globe && <Globe aria-hidden="true" className="size-3.5 text-muted-foreground" />}
        <SelectValue lang={locale}>{LANG_LABELS[locale]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {langs.map((lang) => <SelectItem key={lang} value={lang} lang={lang}>{LANG_LABELS[lang]}</SelectItem>)}
        <SelectItem value="other" render={<Link to="/languages" />}>{labels.languages_other}</SelectItem>
      </SelectContent>
    </Select>
  );
}
