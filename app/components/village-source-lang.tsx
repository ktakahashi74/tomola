import { NativeSelect, NativeSelectOption } from "~/components/ui/native-select";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { LANG_LABELS, type Lang } from "~/lib/languages";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { m } from "~/paraglide/messages.js";

// The language the name and description of a village are written in: a choice among the languages the site uses. Readers of other languages see the texts translated by AI.
// A language that is closed now but is the village's own stays in the list, so saving the form does not change it.
export function VillageSourceLang({ id, defaultValue }: { id: string; defaultValue: Lang | string | null }) {
  const enabled = useEnabledLangs();
  const current = defaultValue && (LANG_LABELS as Record<string, string>)[defaultValue] ? defaultValue as Lang : null;
  const choices = current && !enabled.includes(current) ? [...enabled, current] : enabled;
  return <Field className="min-w-0 max-w-xl"><FieldLabel htmlFor={id}>{m.village_source_lang_field()}</FieldLabel>
    <NativeSelect id={id} name="sourceLang" defaultValue={current ?? enabled[0]} className="w-full">
      {choices.map(lang => <NativeSelectOption key={lang} value={lang} lang={lang}>{LANG_LABELS[lang]}</NativeSelectOption>)}
    </NativeSelect>
    <FieldDescription>{m.village_source_lang_help()}</FieldDescription>
  </Field>;
}
