import { entryFieldError } from "~/lib/entry-field-error";
import { Field, FieldLabel, FieldDescription } from "~/components/ui/field";
import { Badge } from "~/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "~/components/ui/select";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { STANCE_TAGS, type StanceTag } from "~/lib/stances";
import { m } from "~/paraglide/messages.js";

// Reply tags: the author's named stance and reasons, or an objection to the framing of a question. Never match them against unnamed stances.

export function stanceTagLabel(tag: StanceTag): string {
  if (tag === "agree") return m.stance_tag_agree();
  if (tag === "disagree") return m.stance_tag_disagree();
  if (tag === "neither") return m.stance_tag_neither();
  return m.stance_tag_objection();
}

// Tag displayed in the reply heading.
export function StanceTagLabel({ tag }: { tag: StanceTag }) {
  return <Badge variant="secondary" className="bg-info text-info-foreground">{stanceTagLabel(tag)}</Badge>;
}

// Reply/edit-form tag selector, including "印なし" (empty value means no selection). Only place it on replies to questions.
export function StanceTagSelect({ defaultValue, error, errorId }: { defaultValue?: StanceTag | null; error?: string; errorId?: string }) {
  const id = useId();
  const field = useRef<HTMLDivElement>(null);
  const revealHelp = useRef(false);
  const items = [{ value: "", label: m.stance_tag_none() }, ...STANCE_TAGS.map(tag => ({ value: tag, label: stanceTagLabel(tag) }))];
  return (
    <Field ref={field} className="scroll-my-2">
      <FieldLabel htmlFor={id}>{m.stance_tag_label()}</FieldLabel>
      <Select name="stanceTag" defaultValue={defaultValue ?? ""} items={items}
        onValueChange={() => { revealHelp.current = true; }}
        onOpenChangeComplete={(open) => {
          if (!open && revealHelp.current) {
            revealHelp.current = false;
            // Keep the explanation in view after the popup restores focus, including on narrow screens.
            field.current?.scrollIntoView({ block: "nearest" });
          }
        }}>
        <SelectTrigger {...entryFieldError(error, "stanceTag", errorId)} id={id} aria-label={m.stance_tag_label()} aria-describedby={[`${id}-help`, entryFieldError(error, "stanceTag", errorId)["aria-describedby"]].filter(Boolean).join(" ")}><SelectValue /></SelectTrigger>
        <SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
      {/* Keep the help outside the label so it does not become part of the field's accessible name. */}
      <FieldDescription id={`${id}-help`}>{m.stance_tag_help()}</FieldDescription>
    </Field>
  );
}

// The same choice as StanceTagSelect, as a short row of tags above the reply field (the reply form): "no tag" first, then the named stances and the objection to the framing.
// The explanation shows only once a tag is chosen. Radio buttons named like the select (stanceTag), so that the form and the server work as they did, without JavaScript too.
export function StanceTagChips({ defaultValue, error, errorId }: { defaultValue?: StanceTag | null; error?: string; errorId?: string }) {
  const id = useId();
  const [value, setValue] = useState<string>(defaultValue ?? "");
  const items = [{ value: "", label: m.stance_tag_none() }, ...STANCE_TAGS.map(tag => ({ value: tag, label: stanceTagLabel(tag) }))];
  const help = useRef<HTMLParagraphElement>(null);
  const chosen = useRef(false);
  // Choosing a tag shows its explanation; keep it in view (it appears under the row, which may be at the edge of the screen).
  useEffect(() => { if (chosen.current && value) help.current?.scrollIntoView({ block: "nearest" }); }, [value]);
  return <fieldset className="space-y-1" {...entryFieldError(error, "stanceTag", errorId)}>
    <legend className="sr-only">{m.stance_tag_label()}</legend>
    <div role="presentation" className="flex flex-wrap gap-1.5">
      {items.map(item => <label key={item.value} className="relative">
        <input type="radio" name="stanceTag" value={item.value} checked={value === item.value} onChange={() => { chosen.current = true; setValue(item.value); }} aria-label={item.label} aria-describedby={value ? `${id}-help` : undefined} className="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0" />
        <span aria-hidden="true" className="pointer-events-none inline-flex min-h-8 items-center rounded-full border px-3 text-sm text-muted-foreground peer-checked:border-foreground peer-checked:bg-muted peer-checked:font-semibold peer-checked:text-foreground peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50">{item.label}</span>
      </label>)}
    </div>
    {value && <p ref={help} id={`${id}-help`} className="ui-help text-muted-foreground">{m.stance_tag_help()}</p>}
  </fieldset>;
}

const FILTER_LABELS: Record<StanceTag, () => string> = {
  agree: () => m.replies_filter_agree(),
  disagree: () => m.replies_filter_disagree(),
  neither: () => m.replies_filter_neither(),
  objection: () => m.replies_filter_objection(),
};

// Tag-filter links above replies (?tag=), usable without JavaScript. Preserve existing queries such as ?lang= and reset pagination to page one.
export function RepliesFilter({ current }: { current: StanceTag | null }) {
  const location = useLocation();
  const to = (tag: StanceTag | null) => {
    const params = new URLSearchParams(location.search);
    params.delete("page");
    // ?review= is a one-time mark from "Reconsider my stance"; a filter link does not carry it.
    params.delete("review");
    if (tag) params.set("tag", tag);
    else params.delete("tag");
    const search = params.toString();
    return `${location.pathname}${search ? `?${search}` : ""}#replies`;
  };
  const item = (tag: StanceTag | null, label: string) => (
    <Link key={tag ?? "all"} to={to(tag)} aria-current={current === tag ? "true" : undefined} className="choice">
      {label}
    </Link>
  );
  return (
    <nav aria-label={m.replies_filter_label()} className="flex flex-wrap items-center gap-3 ui-meta">
      {item(null, m.replies_filter_all())}
      {STANCE_TAGS.map((tag) => item(tag, FILTER_LABELS[tag]()))}
    </nav>
  );
}
