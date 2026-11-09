import { DocumentHeader } from "~/components/document-header";
import { Link } from "react-router";
import { connectPlan } from "~/lib/api/connect.server";
import { CONNECTIONS_SETTINGS_PATH, CONNECT_MD_PATH } from "~/lib/connect-paths";
import { getSessionUser } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { listConnections } from "~/lib/mcp/connections.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { m } from "~/paraglide/messages.js";
import type { Route } from "./+types/connect";

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const plan = connectPlan();
  const user = await getSessionUser(request);
  const count = user ? (await listConnections(await getDb(), user.id)).length : null;
  return {
    text: {
      prompt: m.connect_prompt({ site: plan.host }),
      internet: m.connect_internet(),
      publish: m.connect_publish(),
      offline: m.connect_offline_heading(),
      publicAddress: m.connect_public_address(),
      memberAddress: m.connect_member_address(),
      copy: m.connect_copy_post({ open: m.open_in_ai(), copy: m.open_in_ai_copy_md() }),
      connections: count === null ? null : count === 0 ? m.connect_connections_empty() : m.connect_connections_count({ count }),
      manage: m.connect_connections_manage(),
      stop: m.connect_stop(),
    },
    mcpUrl: plan.mcpUrl,
    publicMcpUrl: plan.publicReading ? plan.publicMcpUrl : null,
  };
}

// Connection counts belong only to this visitor, including on public sites.
export const headers = () => ({ "X-Robots-Tag": "noindex", "Cache-Control": "private, no-store" });
export function meta() {
  return [{ title: m.footer_connect() }, { name: "robots", content: "noindex" }, { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: CONNECT_MD_PATH }];
}

const addressClass = "whitespace-pre-wrap [overflow-wrap:anywhere] rounded border bg-muted p-2 text-sm select-all";

export default function Connect({ loaderData }: Route.ComponentProps) {
  const { text, mcpUrl, publicMcpUrl } = loaderData;
  return <>
    <DocumentHeader />
    <main className="min-w-0 space-y-6">
      <h1 className="text-2xl font-bold">{m.footer_connect()}</h1>
      <p className="text-lg font-semibold [overflow-wrap:anywhere]">{text.prompt}</p>
      <p>{text.internet}</p>
      <p>{text.publish}</p>
      <section aria-labelledby="connect-offline-heading" className="space-y-3">
        <h2 id="connect-offline-heading" className="text-lg font-semibold">{text.offline}</h2>
        <ul className="list-disc space-y-4 pl-5">
          <li className="min-w-0 space-y-2">
            <p>{text.publicAddress}</p>
            <pre className={addressClass}><code>{publicMcpUrl ?? mcpUrl}</code></pre>
            {publicMcpUrl && <>
              <p>{text.memberAddress}</p>
              <pre className={addressClass}><code>{mcpUrl}</code></pre>
            </>}
          </li>
          <li>{text.copy}</li>
        </ul>
      </section>
      <div className="space-y-2">
        {text.connections !== null && <p><span>{text.connections}</span> <Link to={CONNECTIONS_SETTINGS_PATH} className="underline">{text.manage}</Link></p>}
        <p className="ui-help text-muted-foreground">{text.stop}</p>
      </div>
    </main>
  </>;
}

export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
