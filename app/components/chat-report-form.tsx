import { ReportReasonSelect } from "~/components/report-reason-select";
import { Form } from "react-router";
import { Button } from "./ui/button";
import { Field, FieldLabel } from "./ui/field";
import { Textarea } from "./ui/textarea";
import { m } from "~/paraglide/messages.js";

export function ChatReportForm({ id }: { id: string }) {
  return <div className="ui-meta"><h2 className="font-semibold">{m.chat_reports_flag()}</h2>
    <Form method="post" className="mt-2 space-y-2">
      <input type="hidden" name="intent" value="flag" /><input type="hidden" name="id" value={id} />
      <ReportReasonSelect appearance="native" label={m.mod_reason()} />
      <Field><FieldLabel>{m.flag_note()}<Textarea name="note" rows={2} maxLength={1000} /></FieldLabel></Field>
      <Button type="submit" size="sm">{m.flag_submit()}</Button>
    </Form>
  </div>;
}
