import { useState } from "react";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { displayNamePresentation, singleDisplayNameField, type DisplayNames, type DisplayNamePresentation } from "~/lib/display-names";
import { isLang, type Area } from "~/lib/languages";
import { languageLabel } from "~/lib/language-label";
import { m } from "~/paraglide/messages.js";

export function DisplayNameFields({ homeArea, initial }: { homeArea: Area; initial: DisplayNames }) {
  const single = singleDisplayNameField({ ...initial, homeArea });
  const [native, setNative] = useState(single ? initial.displayName ?? initial.displayNameLatin ?? "" : initial.displayName ?? "");
  const [latin, setLatin] = useState(single ? "" : initial.displayNameLatin ?? "");
  const names = { displayName: native.trim().normalize("NFC"), displayNameLatin: latin.trim().normalize("NFC"), homeArea };
  const rows: (DisplayNamePresentation & { screens: string[] })[] = [];
  const add = (value: DisplayNamePresentation, screen: string) => {
    const row = rows.find(row => row.name === value.name && row.latin === value.latin);
    if (row) row.screens.push(screen);
    else rows.push({ ...value, screens: [screen] });
  };
  if (!single && (names.displayName || names.displayNameLatin)) {
    if (isLang(homeArea)) add(displayNamePresentation(names, homeArea), languageLabel(homeArea));
    const other = displayNamePresentation(names, "");
    for (const locale of ["ja", "zh-Hans", "zh-Hant"] as const) {
      if (locale === homeArea) continue;
      const value = displayNamePresentation(names, locale);
      if (value.name !== other.name || value.latin !== other.latin) add(value, languageLabel(locale));
    }
    add(other, m.display_name_preview_other());
  }
  return <>
    <Field>
      <FieldLabel htmlFor="display-name">{!single && isLang(homeArea) ? m.display_name_language_label({ language: languageLabel(homeArea) }) : m.display_name_label()}</FieldLabel>
      <Input id="display-name" name="displayName" dir="auto" value={native} onChange={event => setNative(event.target.value)} />
    </Field>
    {single ? <input type="hidden" name="displayNameLatin" value="" /> : <Field>
      <FieldLabel htmlFor="display-name-latin">{m.display_name_romanized_label()}</FieldLabel>
      <Input id="display-name-latin" name="displayNameLatin" dir="ltr" value={latin} onChange={event => setLatin(event.target.value)} />
    </Field>}
    <div className="ui-help text-muted-foreground space-y-1" data-display-name-preview="">
      {rows.map((row, index) => <p key={index}>{m.display_name_preview_screens({ languages: row.screens.join(" / ") })}{" "}<bdi>{row.name}</bdi>{row.latin && <> <bdi dir="ltr">{row.latin}</bdi></>}</p>)}
      {!single && names.displayName && !names.displayNameLatin && <p>{m.display_name_other_unchanged()}</p>}
    </div>
  </>;
}
