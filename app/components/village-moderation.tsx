import { AiReportAssessment } from "~/components/ai-report-assessment";
import { VillageIcon } from "~/components/village-icon";
import { ReportReasonSelect } from "~/components/report-reason-select";
import { Form, Link } from "react-router";
import { useId } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { reasonLabel } from "~/components/reason-label";
import { VILLAGE_DESCRIPTION_MAX, VILLAGE_NAME_MAX, VILLAGE_SLUG_MAX } from "~/lib/villages";
import { villageName } from "~/lib/village-name";
import type { VillageMetadata, VillageReportCard, VillageReportTarget } from "~/lib/village-moderation.server";
import { m } from "~/paraglide/messages.js";

export function VillageReportForm({ reported, hasIcon = false }: { reported: VillageReportTarget[]; hasIcon?: boolean }) {
  const available: VillageReportTarget[] = hasIcon ? ["information", "icon"] : ["information"];
  const targets = available.filter(target => !reported.includes(target));
  return <>
    {reported.length > 0 && <p role="status" className="ui-help text-muted-foreground">{m.village_reported()}</p>}
    {targets.length > 0 && <details className="ui-meta"><summary className="cursor-pointer underline">{m.village_report()}</summary>
    <Form method="post" className="mt-2 max-w-xl space-y-3 rounded border p-3 text-sm">
      <input type="hidden" name="intent" value="flag" />
      {hasIcon ? <label className="block space-y-1"><span>{m.village_report_target()}</span><select name="target" className="rounded border bg-background p-2">{targets.map(target => <option key={target} value={target}>{target === "icon" ? m.village_icon_label() : m.village_report_information()}</option>)}</select></label> : <input type="hidden" name="target" value="information" />}
      <ReportReasonSelect appearance="plain" />
      <label className="block space-y-1"><span>{m.flag_note()}</span><Textarea name="note" rows={3} maxLength={1000} /></label>
      <p className="ui-help text-muted-foreground">{m.flag_privacy()}</p>
      <Button type="submit" variant="outline">{m.flag_submit()}</Button>
    </Form>
  </details>}
  </>;
}
export function VillageMetadataView({ value, label }: { value: VillageMetadata; label: string }) {
  return <div className="space-y-1 [overflow-wrap:anywhere]">
    <h3 className="text-sm font-semibold">{label}</h3>
    <p>{villageName(value)}</p><p className="ui-meta">/v/{value.slug}</p>
    <pre className="whitespace-pre-wrap font-sans text-sm">{value.description}</pre>
  </div>;
}
export function VillageAppealDetails({ village, before }: { village: VillageMetadata | null; before: VillageMetadata | null }) {
  return <div className="grid gap-3 sm:grid-cols-2">
    {before && <VillageMetadataView value={before} label={m.village_before_correction()} />}
    {village && <VillageMetadataView value={village} label={m.village_report_current()} />}
  </div>;
}
type Card = Omit<VillageReportCard, "reports"> & { reports: Array<Omit<VillageReportCard["reports"][number], "createdAt"> & { createdAt: string }> };
export function VillageModerationCard({ card: c, handled, returnTo }: { card: Card; handled: boolean; returnTo: string }) {
  const descriptionId = useId();
  return <section id={`v-report-${c.reportId ?? c.village.slug}`} className="space-y-3 rounded border p-4 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap gap-2 ui-meta"><span>{m.mod_kind_village()}</span><span>{c.village.kind === "invite_public" ? m.village_invite_public() : m.village_open()}</span>{c.village.ended && <span>{m.village_ended()}</span>}
      <Link className="underline" to={`/v/${c.village.slug}`}>{m.notification_open()}</Link>
    </div>
    {c.iconUrl && <VillageIcon src={c.iconUrl} className="size-16 rounded" />}
    <VillageMetadataView value={c.village} label={m.village_report_current()} />
    {c.creatorHandle && <Link className="block ui-meta underline" to={`/admin/roles?q=${encodeURIComponent(c.creatorHandle)}`}>{m.village_mod_creator({ handle: c.creatorHandle })}</Link>}
    <p className="ui-meta">{m.village_owner()}： {c.ownerHandles.map(handle => <Link key={handle} className="me-3 underline" to={`/admin/roles?q=${encodeURIComponent(handle)}`}>@{handle}</Link>)}</p>
    <ul className="space-y-3">{c.reports.map(r => <li key={r.id} className="space-y-1 rounded border p-2">
      <p className="ui-meta">{m.village_report_target()}： {r.target === "icon" ? m.village_icon_label() : m.village_report_information()}</p>
      <p className="ui-meta">{reasonLabel(r.reason)} ({r.createdAt})</p>
      {r.iconUrl && <VillageIcon src={r.iconUrl} className="size-16 rounded" />}
      {r.note && <p className="whitespace-pre-wrap text-sm">{r.note}</p>}
      <AiReportAssessment report={r} />
      {r.snapshot ? <VillageMetadataView value={{ ...r.snapshot, language: c.village.language }} label={m.village_report_snapshot()} /> : <p className="ui-help">{m.village_report_snapshot_pruned()}</p>}
    </li>)}</ul>
    {c.village.language && <Link className="underline" to={`/v/${c.village.slug}${!handled && c.reportId !== null ? `?resolveReport=${c.reportId}` : ""}`}>{m.village_edit()}</Link>}
    {!handled && !c.owned && <Form key={c.version} method="post" className="max-w-xl space-y-3">
      {c.reportId !== null ? <input type="hidden" name="reportId" value={c.reportId} /> : <input type="hidden" name="slugTarget" value={c.village.slug ?? ""} />}<input type="hidden" name="villageVersion" value={c.version} /><input type="hidden" name="returnTo" value={returnTo} />
      {!c.village.language && <>
        <label className="block space-y-1"><span>{m.village_name_field()}</span><Input name="name" defaultValue={c.village.name} maxLength={VILLAGE_NAME_MAX} /></label>
        <label className="block space-y-1"><span>{m.village_slug_field()}</span><Input name="slug" defaultValue={c.village.slug ?? ""} maxLength={VILLAGE_SLUG_MAX} /></label>
      </>}
      <div className="space-y-1"><label htmlFor={descriptionId}>{m.village_description_field()}</label><Textarea id={descriptionId} name="description" defaultValue={c.village.description} maxLength={VILLAGE_DESCRIPTION_MAX} disabled={!!c.village.language} /></div>
      <ReportReasonSelect appearance="plain" defaultValue={c.reports[0]?.reason ?? "other"} />
      <label className="block space-y-1"><span>{m.village_mod_note()}</span><Textarea name="note" maxLength={500} /></label>
      <div className="flex flex-wrap gap-3">{c.iconUrl && <Button type="submit" name="intent" value="village-clear-icon" variant="outline">{m.village_icon_clear()}</Button>}{!c.village.language && <Button type="submit" name="intent" value="village-fix">{m.village_mod_fix()}</Button>}{c.reportId !== null && <Button type="submit" name="intent" value="village-dismiss" variant="outline">{m.mod_dismiss()}</Button>}</div>
      {!c.village.language && !c.village.ended && <div className="space-y-2 border-t pt-2">
        <label className="flex items-center gap-2 text-sm"><Checkbox name="confirm" value="1" />{m.village_mod_end_confirm()}</label>
        <Button type="submit" name="intent" value="village-end" variant="destructive">{m.village_mod_end()}</Button>
      </div>}
    </Form>}
  </section>;
}
