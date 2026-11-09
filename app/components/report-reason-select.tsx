import { useId } from "react";
import { Field, FieldLabel } from "./ui/field";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { REPORT_REASONS } from "~/lib/moderation";
import { reasonLabel } from "./reason-label";
import { m } from "~/paraglide/messages.js";

export function ReportReasonSelect({ defaultValue = "spam", label = m.flag_reason(), appearance = "field" }: { defaultValue?: string; label?: string; appearance?: "field" | "plain" | "native" }) {
  const id = useId();
  const items = REPORT_REASONS.map(reason => ({ value: reason, label: reasonLabel(reason) }));
  if (appearance === "native") return <Field><FieldLabel htmlFor={id}>{label}<select id={id} name="reason" defaultValue={defaultValue} className="rounded border p-2">{items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></FieldLabel></Field>;
  const control = <Select name="reason" defaultValue={defaultValue} items={items}><SelectTrigger id={id} aria-label={label}><SelectValue /></SelectTrigger><SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select>;
  return appearance === "plain" ? <div className="space-y-1"><label htmlFor={id}>{label}</label>{control}</div> : <Field><FieldLabel htmlFor={id}>{label}</FieldLabel>{control}</Field>;
}
