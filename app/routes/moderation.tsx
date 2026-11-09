import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { Link } from "react-router";
import type { Route } from "./+types/moderation";
import { Pagination } from "~/components/pagination";
import { reasonLabel } from "~/components/reason-label";
import { requireMember } from "~/lib/auth/session.server";
import { LANG_LABELS } from "~/lib/languages";
import type { ModerationAction } from "~/lib/moderation";
import { listPublicLog } from "~/lib/moderation.server";
import { parsePage } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";

// Moderation log visible to members: action kind, reason category, source language, and date only. Omit actor, reporter, explanation, and post links.
// Suspended members may view it; suspension does not block reading.
export function meta({}: Route.MetaArgs) {
  return [{ title: m.moderation_log_title() }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { db } = await requireMember(request);
  const result = await listPublicLog(db, { page: parsePage(request) });
  return { ...(result.entries.some(e => "village" in e) ? { villageLinks: villagesEnabled() } : {}), entries: result.entries, page: result.page, hasNext: result.hasNext };
}

function actionLabel(action: ModerationAction): string {
  switch (action) {
    case "clear_village_icon": return m.log_village_icon_removed();
    case "restore_village_icon": return m.log_village_icon_restored();
    case "clear_avatar": return m.log_avatar_removed();
    case "restore_avatar": return m.log_avatar_restored();
    case "dismiss_avatar_report": return m.mod_dismiss();
    case "clear_display_name": return m.notification_display_name_removed();
    case "restore_display_name": return m.log_display_name_restored();
    case "dismiss_display_name_report": return m.mod_dismiss();
    case "delete_media": return m.moderation_action_delete_media();
    case "hide_chat": return m.log_action_hide_chat();
    case "unhide_chat": return m.log_action_unhide_chat();
    case "dismiss_chat_report": return m.mod_dismiss();
    case "fix_village":
      return m.log_action_fix_village();
    case "end_village":
      return m.log_action_end_village();
    case "unfix_village":
      return m.log_action_unfix_village();
    case "reopen_village":
      return m.log_action_reopen_village();
    case "dismiss_village_report":
      return m.log_action_dismiss_village_report();
    case "hide":
      return m.log_action_hide();
    case "unhide":
      return m.log_action_unhide();
    case "suspend":
      return m.log_action_suspend();
    case "unsuspend":
      return m.log_action_unsuspend();
    case "dismiss_report":
      return m.log_action_dismiss_report();
    case "delete":
      return m.log_action_delete();
    case "restore":
      return m.log_action_restore();
    case "exclude_reactions":
      return m.log_action_exclude_reactions();
    case "include_reactions":
      return m.log_action_include_reactions();
    case "fix_entry":
      return m.log_action_fix_entry();
    case "unfix_entry":
      return m.log_action_unfix_entry();
  }
}

export default function ModerationLog({ loaderData }: Route.ComponentProps) {
  const { entries, page, hasNext } = loaderData;
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{m.moderation_log_title()}</h1>
      <p className="ui-help text-muted-foreground">{m.moderation_log_intro()}</p>
      {entries.length === 0 ? (
        <p>{m.moderation_log_empty()}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-3">{m.moderation_log_col_date()}</TableHead>
                <TableHead className="py-1 pe-3">{m.moderation_log_col_action()}</TableHead>
                <TableHead className="py-1 pe-3">{m.moderation_log_col_reason()}</TableHead>
                <TableHead className="py-1 pe-3">{entries.some(e => "village" in e || "place" in e) ? m.moderation_log_col_place() : m.moderation_log_col_lang()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e, i) => (
                <TableRow key={i} className="border-b align-top">
                  <TableCell className="py-1 pe-3">
                    <time dateTime={e.date}>{e.date}</time>
                  </TableCell>
                  <TableCell className="py-1 pe-3">{actionLabel(e.action)}{e.automatic && <span className="ms-2 ui-meta">{m.moderation_automatic()}</span>}</TableCell>
                  <TableCell className="py-1 pe-3">{reasonLabel(e.reason)}</TableCell>
                  <TableCell className="py-1 pe-3">{"place" in e ? m.mod_kind_chat() : "village" in e ? e.village ? loaderData.villageLinks ? <Link className="underline" to={`/v/${e.village.slug}`}>{e.village.name}</Link> : e.village.name : m.mod_kind_village() : e.lang ? <span lang={e.lang}>{LANG_LABELS[e.lang]}</span> : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={page} hasNext={hasNext} />
    </main>
  );
}
