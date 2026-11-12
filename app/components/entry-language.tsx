import { Field, FieldLabel } from "~/components/ui/field";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "~/components/ui/select";
import { useContext, useEffect, useId, useState } from "react";
import { FormLanguageChangeContext } from "~/components/form-contexts";
import { entryFieldError } from "~/lib/entry-field-error";
import { LANG_LABELS, type SourceLang } from "~/lib/languages";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { m } from "~/paraglide/messages.js";

export function EntryLanguage({ defaultLang, selectedLang, pasteFrontmatter, value, onChange, error, errorId, label = m.field_lang() }: {
  defaultLang?: SourceLang;
  selectedLang?: string;
  pasteFrontmatter?: boolean;
  value?: string;
  onChange?: (value: string) => void;
  disabledClosed?: boolean;
  error?: string;
  errorId?: string;
  label?: string;
}) {
  // Writing may use an unopened source; only enabled languages are individually selectable.
  const enabled = useEnabledLangs();
  const retained = defaultLang && defaultLang !== "other" && !enabled.some(lang => lang === defaultLang) ? defaultLang : null;
  const id = useId();
  const [chosen, setChosen] = useState(selectedLang ?? (pasteFrontmatter ? "" : defaultLang ?? enabled[0]));
  const changeFromReview = useContext(FormLanguageChangeContext);
  const choose = (next: string) => {
    if (value === undefined) setChosen(next);
    onChange?.(next);
  };
  useEffect(() => {
    if (!changeFromReview) return;
    changeFromReview.current = choose;
    return () => { changeFromReview.current = null; };
  }, [changeFromReview, value, onChange]);
  const items = [
    ...(pasteFrontmatter ? [{ value: "", label: m.field_lang_auto() }] : []),
    ...enabled.map(lang => ({ value: lang, label: <span lang={lang}>{LANG_LABELS[lang]}</span> })),
    { value: "other", label: m.source_language_other() },
    ...(retained ? [{ value: retained, label: m.source_language_other() }] : []),

  ];
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select name="lang" items={items} value={value ?? chosen} onValueChange={next => { if (next !== null) choose(next); }}>
        <SelectTrigger {...entryFieldError(error, "lang", errorId)} id={id} aria-label={label} className="max-w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{items.filter(item => item.value !== retained).map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  );
}
