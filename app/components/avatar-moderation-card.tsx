import { Form, Link } from "react-router";
import type { AvatarReportCard } from "~/lib/avatar-moderation.server";
import { REPORT_REASONS } from "~/lib/moderation";
import { reasonLabel } from "./reason-label";
import { Field, FieldLabel } from "./ui/field";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { m } from "~/paraglide/messages.js";

type Card = Omit<AvatarReportCard, "reports"> & { reports: Array<Omit<AvatarReportCard["reports"][number], "createdAt"> & { createdAt: string }> };
export function AvatarModerationCard({ card: c, handled, returnTo }: { card: Card; handled: boolean; returnTo: string }) {
  return <section className="space-y-2 rounded border p-4">
    <p><Link to={`/u/${c.handle}`} className="underline">@{c.handle}</Link></p>
    <h3>{m.avatar_current()}</h3><img src={c.url} alt="" width="64" height="64" className="rounded" />
    {c.reports.map(report => <div key={report.id}><h3>{m.avatar_reported()}</h3>{report.url && <img src={report.url} alt="" width="64" height="64" className="rounded" />}<p>{reasonLabel(report.reason)} · {report.createdAt}</p><p className="whitespace-pre-wrap">{report.note}</p></div>)}
    {!handled && <Form method="post" className="space-y-2">
      <input type="hidden" name="userId" value={c.userId} /><input type="hidden" name="reportId" value={c.reports[0].id} />
      <input type="hidden" name="avatarVersion" value={c.version} /><input type="hidden" name="returnTo" value={returnTo} />
      <Field><FieldLabel>{m.mod_reason()}<select name="reason" defaultValue={c.reports[0].reason}>{REPORT_REASONS.map(reason => <option key={reason} value={reason}>{reasonLabel(reason)}</option>)}</select></FieldLabel></Field>
      <Field><FieldLabel>{m.mod_note()}<Textarea name="note" maxLength={500} /></FieldLabel></Field>
      <div className="flex flex-wrap gap-2"><Button type="submit" name="intent" value="clear-avatar" variant="outline">{m.avatar_clear()}</Button><Button type="submit" name="intent" value="dismiss-avatar" variant="outline">{m.mod_dismiss()}</Button></div>
    </Form>}
  </section>;
}
