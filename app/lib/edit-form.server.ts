import { formString, readEntryForm } from "~/lib/entry-form.server";
import { isStanceTag } from "~/lib/stances";
import { m } from "~/paraglide/messages.js";

export function editFormVersion(form: FormData): string | undefined {
  return form.has("editVersion") ? formString(form, "editVersion") : undefined;
}

export function editFormValues(form: FormData) {
  const { title, body, lang, stanceTag } = readEntryForm(form);
  return { title, body, lang, note: formString(form, "note"), editVersion: editFormVersion(form),
    stanceTag: isStanceTag(stanceTag) ? stanceTag : null };
}

// Keep these translations on the server so reading pages do not load edit-only messages.
export function editConflict(error: string, href: string) {
  return error === "edit_conflict" || error === "approval_changed"
    ? { message: m.edit_conflict(), label: m.edit_open_latest(), href } : undefined;
}
