import { Form } from "react-router";
import { ReportReasonSelect } from "./report-reason-select";
import { FieldLabel } from "./ui/field";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { m } from "~/paraglide/messages.js";

export default function DisplayNameReport({ avatar = false }: { avatar?: boolean }) {
  return <Form method="post" className="space-y-2 rounded border p-3">
    <input type="hidden" name="intent" value={avatar ? "report-avatar" : "report-display-name"} />
    <ReportReasonSelect label={m.flag_reason()} defaultValue="other" />
    <FieldLabel className="w-full flex-col items-start">{m.flag_note()}<Textarea name="note" rows={3} maxLength={1000} /></FieldLabel>
    <p className="ui-help text-muted-foreground">{m.flag_privacy()}</p>
    <Button type="submit" variant="outline">{m.flag_submit()}</Button>
  </Form>;
}
