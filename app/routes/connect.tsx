import { DocumentHeader } from "~/components/document-header";
import { CopyTextButton } from "~/components/copy-text-button";
import { Link } from "react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { connectPlan } from "~/lib/api/connect.server";
import { CONNECTIONS_SETTINGS_PATH, CONNECT_MD_PATH } from "~/lib/connect-paths";
import { getSessionUser } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { listConnections } from "~/lib/mcp/connections.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { m } from "~/paraglide/messages.js";
import { WRITING_PATH } from "~/lib/writing-paths";
import { REPLY_MORE_SYMBOL } from "~/lib/reply-more";
import type { Route } from "./+types/connect";

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const plan = connectPlan();
  const user = await getSessionUser(request);
  const count = user ? (await listConnections(await getDb(), user.id)).length : null;
  return {
    text: {
      prompt: user ? m.connect_member_prompt({ site: plan.host }) : m.connect_prompt({ site: plan.host }),
      internet: m.connect_internet(),
      publish: m.connect_publish({ title: m.mcp_connect_title(), allow: m.mcp_allow() }),
      offline: m.connect_offline_heading(),
      write: m.connect_write_without_connection({ write: m.ai_write_button(), more: REPLY_MORE_SYMBOL }),
      copyAddress: m.connect_copy_address(),
      copiedAddress: m.connect_address_copied(),
      copyFailed: m.connect_copy_failed(),
      copy: m.connect_copy_post({ open: m.open_in_ai(), copy: m.open_in_ai_copy_md() }),
      connections: count === null ? null : count === 0 ? m.connect_connections_empty() : m.connect_connections_count({ count }),
      connectionsReadOnly: m.connect_connections_read_only(),
      manage: m.connect_connections_manage(),
      stop: m.connect_stop(),
    },
    addresses: [
      { url: user || !plan.publicReading ? plan.mcpUrl : plan.publicMcpUrl,
        label: !user && !plan.publicReading ? m.connect_members_address() : m.connect_public_address() },
      ...(plan.publicReading ? [{ url: user ? plan.publicMcpUrl : plan.mcpUrl,
        label: user ? m.connect_read_only_address() : m.connect_member_address() }] : []),
    ],
  };
}

// Connection counts belong only to this visitor, including on public sites.
export const headers = () => ({ "X-Robots-Tag": "noindex", "Cache-Control": "private, no-store" });
export function meta() {
  return [{ title: m.footer_connect() }, { name: "robots", content: "noindex" }, { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: CONNECT_MD_PATH }];
}

const addressClass = "whitespace-pre-wrap [overflow-wrap:anywhere] rounded border bg-muted p-2 text-sm select-all";
const subscribe = () => () => {};

export default function Connect({ loaderData }: Route.ComponentProps) {
  const { text, addresses } = loaderData;
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!copiedUrl) return;
    const timer = setTimeout(() => setCopiedUrl(null), 2500);
    return () => clearTimeout(timer);
  }, [copiedUrl]);
  return <>
    <DocumentHeader />
    <main className="min-w-0 space-y-6">
      <h1 className="text-2xl font-bold">{m.footer_connect()}</h1>
      <p className="text-lg font-semibold [overflow-wrap:anywhere]">{text.prompt}</p>
      <p>{text.internet}</p>
      <div className="space-y-4">
        {addresses.map(({ label, url }, index) => <fieldset key={url} disabled={!hydrated} role="group" aria-labelledby={`connect-address-${index}`} className="min-w-0 space-y-2">
          <p id={`connect-address-${index}`}>{label}</p>
          <div className="flex flex-wrap items-center gap-2">
            <pre className={`${addressClass} min-w-0 flex-1`}><code>{url}</code></pre>
            <CopyTextButton text={url} label={copiedUrl === url ? text.copiedAddress : text.copyAddress} copiedLabel={text.copiedAddress} failedLabel={text.copyFailed} showCopied={copiedUrl === url} onResult={copied => setCopiedUrl(copied ? url : null)} />
          </div>
        </fieldset>)}
      </div>
      <p><span>{text.write}</span> <Link to={WRITING_PATH} className="underline">{m.writing_guide_title()}</Link></p>
      <p>{text.publish}</p>
      <section aria-labelledby="connect-offline-heading" className="space-y-3">
        <h2 id="connect-offline-heading" className="text-lg font-semibold">{text.offline}</h2>
        <p>{text.copy}</p>
      </section>
      <div className="space-y-2">
        {text.connections !== null && <>
          <p><span>{text.connections}</span> <Link to={CONNECTIONS_SETTINGS_PATH} className="underline">{text.manage}</Link></p>
          <p className="ui-help text-muted-foreground">{text.connectionsReadOnly}</p>
        </>}
        <p className="ui-help text-muted-foreground">{text.stop}</p>
      </div>
    </main>
  </>;
}

export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
