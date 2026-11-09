import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import type { Route } from "./+types/admin-invitations";
import { requireOperator } from "~/lib/auth/session.server";
import { listInvitations, revokeInvitation, type InvitationStatus } from "~/lib/invitations.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { data, Form } from "react-router";
import { Button } from "~/components/ui/button";
import { m } from "~/paraglide/messages.js";

// Invitation list for operators (OPERATOR_EMAILS) only; other members get 404. Invitation URLs cannot be shown because only their hashes are stored.
const LIMIT = 200;

// This page lists invitation recipients' email addresses; prevent storage, indexing, and Referer transmission.
export function headers() {
  return { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
}

export async function loader({ request }: Route.LoaderArgs) {
  const { db } = await requireOperator(request);
  const rows = await listInvitations(db, { limit: LIMIT });
  return { rows, limit: LIMIT };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user } = await requireOperator(request);
  const form = await request.formData();
  if (form.get("intent") !== "revoke") throw data("Bad request", { status: 400 });
  if (!await revokeInvitation(db, user.id, String(form.get("id") ?? ""), { operator: true })) throw data("Not found", { status: 404 });
  return null;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.admin_invitations_title() }];
}

function statusLabel(status: InvitationStatus): string {
  return status === "valid" ? m.admin_invitations_status_valid() : status === "used" ? m.admin_invitations_status_used() : status === "revoked" ? m.invites_revoked() : m.admin_invitations_status_expired();
}

const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default function AdminInvitations({ loaderData }: Route.ComponentProps) {
  const { rows, limit } = loaderData;
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{m.admin_invitations_title()}</h1>
      <p className="ui-help text-muted-foreground">{m.admin_invitations_intro()}</p>
      {rows.length === 0 ? (
        <p>{m.admin_invitations_empty()}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-3">{m.admin_invitations_col_email()}</TableHead>
                <TableHead className="py-1 pe-3">{m.admin_invitations_col_inviter()}</TableHead>
                <TableHead className="py-1 pe-3">{m.admin_invitations_col_created()}</TableHead>
                <TableHead className="py-1 pe-3">{m.admin_invitations_col_expires()}</TableHead>
                <TableHead className="py-1 pe-3">{m.admin_invitations_col_status()}</TableHead>
                <TableHead className="py-1 pe-3">{m.admin_invitations_col_used_by()}</TableHead>
                <TableHead className="py-1 pe-3">{m.admin_invitations_col_used_at()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="border-b align-top">
                  <TableCell className="py-1 pe-3 break-all">{r.email ?? m.invites_recipient_removed()}</TableCell>
                  <TableCell className="py-1 pe-3">{r.inviterHandle ? `@${r.inviterHandle}` : m.admin_invitations_inviter_none()}</TableCell>
                  <TableCell className="py-1 pe-3">
                    <time dateTime={r.createdAt.toISOString()}>{when(r.createdAt)}</time>
                  </TableCell>
                  <TableCell className="py-1 pe-3">
                    <time dateTime={r.expiresAt.toISOString()}>{when(r.expiresAt)}</time>
                  </TableCell>
                  <TableCell className="py-1 pe-3">{statusLabel(r.status)}{r.status === "valid" && <Form method="post"><input type="hidden" name="intent" value="revoke" /><input type="hidden" name="id" value={r.id} /><Button type="submit" variant="outline">{m.invites_revoke()}</Button></Form>}</TableCell>
                  <TableCell className="py-1 pe-3">
                    {r.status !== "used"
                      ? "—"
                      : r.usedByHandle
                        ? `@${r.usedByHandle}`
                        : r.usedByExists
                          ? m.admin_invitations_used_by_no_profile()
                          : m.admin_invitations_used_by_no_account()}
                  </TableCell>
                  <TableCell className="py-1 pe-3">{r.usedAt ? <time dateTime={r.usedAt.toISOString()}>{when(r.usedAt)}</time> : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {rows.length >= limit && <p className="ui-help text-muted-foreground">{m.admin_invitations_limit({ count: limit })}</p>}
    </main>
  );
}
