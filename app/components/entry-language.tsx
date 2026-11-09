import { Field, FieldLabel } from "~/components/ui/field";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "~/components/ui/select";
import { useContext, useEffect, useId, useState } from "react";
import { FormLanguageChangeContext } from "~/components/form-contexts";
import { entryFieldError } from "~/lib/entry-field-error";
import { LANG_LABELS, type Lang } from "~/lib/languages";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { m } from "~/paraglide/messages.js";

export function EntryLanguage({ defaultLang, selectedLang, pasteFrontmatter, value, onChange, disabledClosed, error, errorId, label = m.field_lang() }: {
  defaultLang?: Lang;
  selectedLang?: string;
  pasteFrontmatter?: boolean;
  value?: string;
  onChange?: (value: string) => void;
  disabledClosed?: boolean;
  error?: string;
  errorId?: string;
  label?: string;
}) {
  // The post language choices are the enabled languages (ENABLED_LANGS) only. The language of a draft that was saved before the language was closed (defaultLang) stays at the end,
  // marked "not open at the moment" (publishing then fails with invalid_lang and asks for another language).
  const enabled = useEnabledLangs();
  const closedDefault = defaultLang && !enabled.includes(defaultLang) ? defaultLang : null;
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
    ...(closedDefault && !pasteFrontmatter ? [{ value: closedDefault, label: <span lang={closedDefault}>{m.lang_not_open({ lang: LANG_LABELS[closedDefault] })}</span> }] : []),
  ];
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select name="lang" items={items} value={value ?? chosen} onValueChange={next => { if (next !== null) choose(next); }}>
        <SelectTrigger {...entryFieldError(error, "lang", errorId)} id={id} aria-label={label} className="max-w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value} disabled={disabledClosed && item.value === closedDefault}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  );
}
