import { Link, redirect } from "react-router";
import type { Route } from "./+types/suspended";
import { reasonLabel } from "~/components/reason-label";
import { requireMember } from "~/lib/auth/session.server";
import { m } from "~/paraglide/messages.js";

// Suspension explanation screen, reached through the requireWriter gate. Login and reading remain available. Redirect home if not suspended.
export function meta({}: Route.MetaArgs) {
  return [{ title: m.suspended_title() }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { profile } = await requireMember(request);
  if (profile.suspendedUntil === null || profile.suspendedUntil <= new Date()) throw redirect("/");
  return {
    until: profile.suspendedUntil.toISOString().slice(0, 16).replace("T", " "),
    reason: profile.suspendedReason,
    actionId: profile.suspendedActionId,
  };
}

export default function Suspended({ loaderData }: Route.ComponentProps) {
  const { until, reason, actionId } = loaderData;
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{m.suspended_title()}</h1>
      <p>{m.suspended_body({ until })}</p>
      {reason && <p>{m.suspended_reason({ reason: reasonLabel(reason) })}</p>}
      <p className="ui-help text-muted-foreground">{m.suspended_can()}</p>
      {actionId !== null && (
        <p>
          <Link to={`/appeal/${actionId}`} className="underline">
            {m.suspended_appeal()}
          </Link>
        </p>
      )}
    </main>
  );
}
