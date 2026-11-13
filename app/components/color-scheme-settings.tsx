import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";
import { Field, FieldLabel } from "~/components/ui/field";
import { NativeSelect, NativeSelectOption } from "~/components/ui/native-select";
import { SettingsSaveStatus, useSettingsAutosave } from "~/components/settings-autosave";
import type { ColorScheme } from "~/lib/theme-colors";
import { m } from "~/paraglide/messages.js";

export function ColorSchemeSettings({ initial }: { initial: ColorScheme | null }) {
  const control = useRef<HTMLSelectElement>(null);
  const appearance = useSettingsAutosave<string>(initial ?? "", "colorScheme", control);
  const { revalidate } = useRevalidator();
  // Refresh the root's saved preference without discarding other settings edits.
  useEffect(() => {
    if (appearance.status === "saved") void revalidate();
  }, [appearance.status, appearance.value, revalidate]);
  return <Field className="min-w-0 w-auto" id="settings-appearance">
    <FieldLabel htmlFor="settings-color-scheme">{m.settings_color_scheme()}</FieldLabel>
    <NativeSelect ref={control} id="settings-color-scheme" name="colorScheme" value={appearance.value} onChange={event => appearance.change(event.target.value)} className="w-full">
      <NativeSelectOption value="">{m.settings_color_scheme_device()}</NativeSelectOption>
      <NativeSelectOption value="light">{m.settings_color_scheme_light()}</NativeSelectOption>
      <NativeSelectOption value="dark">{m.settings_color_scheme_dark()}</NativeSelectOption>
    </NativeSelect>
    <SettingsSaveStatus {...appearance} />
  </Field>;
}
