// Associate validation failures with the input that can resolve them.
export function entryFieldError(error: string | undefined, field: string, id: string | undefined) {
  const fields: Record<string, string[]> = {
    title: ["invalid_title"],
    body: ["body_required", "body_too_long", "body_too_complex", "body_unrenderable", "frontmatter_invalid", "frontmatter_type_mismatch", "invalid_intro"],
    lang: ["invalid_lang"],
    stanceTag: ["invalid_stance_tag"],
    village: ["village_required", "village_changed"],
    note: ["invalid_note", "note_required"],
  };
  const invalid = !!error && !!fields[field]?.includes(error);
  return { "aria-invalid": invalid || undefined, "aria-describedby": invalid ? id : undefined };
}
