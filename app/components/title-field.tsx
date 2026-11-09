import { entryFieldError } from "~/lib/entry-field-error";
import { Input } from "~/components/ui/input";
import { type ChangeEventHandler, type Ref } from "react";
import { m } from "~/paraglide/messages.js";

// The title field of a topic: optional (a short remark has no title), except for a question (a topic that asks for stances), which needs its title,
// the proposition. `required` is the browser's check when there is JavaScript; without it the server answers invalid_title and keeps what was written.
// The field has no drawn label or help text: its name is the placeholder, which says what goes in it ("Title (optional)", or the question, with an example, while the title is
// required) and is also the accessible name. A form that may get its title from pasted frontmatter passes `required` false but `mustHave` true: the name still says
// "required", and the server answers invalid_title if no title comes from anywhere.
export function TitleField({ ref, defaultValue, value, onChange, required, mustHave = required, error, errorId }: { error?: string; errorId?: string; ref?: Ref<HTMLInputElement>; defaultValue?: string; value?: string; onChange?: ChangeEventHandler<HTMLInputElement>; required: boolean; mustHave?: boolean }) {
  const name = mustHave ? m.field_title_required() : m.field_title();
  return (
    <Input {...entryFieldError(error, "title", errorId)} dir="auto" ref={ref} name="title" required={required} aria-label={name} placeholder={mustHave ? m.field_title_placeholder_question() : name} aria-required={mustHave && !required ? true : undefined} maxLength={200} defaultValue={defaultValue} value={value} onChange={onChange} className="h-10" />
  );
}
