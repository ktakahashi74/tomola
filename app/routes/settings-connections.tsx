import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Button } from "~/components/ui/button";
import { LocalTime } from "~/components/local-time";
import { siteUrl } from "~/lib/md/urls.server";
import { data, Form, Link } from "react-router";
import { requireMember } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { listConnections, revokeConnection } from "~/lib/mcp/connections.server";
import { CONNECT_PATH } from "~/lib/connect-paths";
import { m } from "~/paraglide/messages.js";
import type { Route } from "./+types/settings-connections";
export const meta = () => [{ title: m.mcp_connections_title() }];
export const headers = () => ({ "Cache-Control": "private, no-store" });
async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { db, user } = await requireMember(request);
  return { endpoint: siteUrl("/mcp"), connections: await listConnections(db, user.id) };
}
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user } = await requireMember(request);
  const form = await request.formData();
  if (!(await revokeConnection(db, user.id, String(form.get("id") ?? "")))) throw data("Not found", { status: 404 });
  return { revoked: true };
}
const PERMISSIONS: Record<string, () => string> = { read: () => m.mcp_perm_read(), draft: () => m.mcp_perm_draft(), offline_access: () => m.mcp_perm_offline() };

export default function SettingsConnections({ loaderData, actionData }: Route.ComponentProps) {
  const [beforeConnect, afterConnect] = m.mcp_connections_intro({ link: "\u0000" }).split("\u0000");
  return <main className="space-y-4"><p className="ui-meta"><Link to="/settings" className="underline">{m.settings_title()}</Link></p><h1 className="text-2xl font-bold">{m.mcp_connections_title()}</h1>
    <section className="space-y-2"><p>{beforeConnect}<Link to={CONNECT_PATH} className="underline">{m.mcp_connections_link()}</Link>{afterConnect}</p>
      <p>{m.mcp_endpoint_label()}: <code className="break-all">{loaderData.endpoint}</code></p>
      <p className="ui-help text-muted-foreground">{m.mcp_connections_grouped()}</p>
    </section><p>{m.mcp_disclosure()}</p>
    <a href="/settings/tokens">{m.mcp_personal_tokens()}</a>{actionData?.revoked && <p role="status">{m.mcp_revoked()}</p>}
    {loaderData.connections.length === 0 && <p>{m.mcp_connections_empty()}</p>}
    {loaderData.connections.map((connection) => <section key={connection.id} className="rounded border p-3"><h2>{connection.name ?? connection.clientId}</h2>
      <p className="break-all">{connection.clientId}</p>{connection.uri && <p>{connection.uri}</p>}
      <p>{connection.scopes.map((scope) => PERMISSIONS[scope]?.() ?? scope).join(", ")}</p><p>{m.mcp_last_used()}: {connection.lastUsedAt ? <LocalTime iso={connection.lastUsedAt.toISOString()} style="stamp" /> : m.mcp_never_used()}</p>
      <Form method="post"><input type="hidden" name="id" value={connection.id} /><Button type="submit" variant="destructive">{m.mcp_revoke()}</Button></Form>
    </section>)}</main>;
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
