import { Link } from "react-router";
import { GuestHeader } from "~/components/guest-header";
import { CONNECT_MD_PATH } from "~/lib/connect-paths";
import { m } from "~/paraglide/messages.js";
import type { Route } from "./+types/mcp-error";

// Where a browser lands when the authorization server refuses a request an AI tool made (an unknown permission, a return address it did not register). The refusal itself stays local:
// nothing is sent back to the AI's redirect address. Only a short error code arrives in the query; the page chooses its own words by it.
export const headers = () => ({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
export function meta() { return [{ title: m.mcp_error_title() }, { name: "robots", content: "noindex" }]; }

export function loader({ request }: Route.LoaderArgs) {
  const error = new URL(request.url).searchParams.get("error") ?? "";
  return { kind: error === "invalid_scope" ? "scope" as const : error === "invalid_request" || error === "invalid_redirect" || error === "invalid_redirect_uri" ? "request" as const : "other" as const };
}

export default function McpError({ loaderData }: Route.ComponentProps) {
  const [before, after] = m.mcp_error_hint({ link: "\u0000" }).split("\u0000");
  return <><GuestHeader /><main className="space-y-4">
    <h1 className="text-2xl font-bold">{m.mcp_error_title()}</h1>
    <p>{loaderData.kind === "scope" ? m.mcp_error_scope() : loaderData.kind === "request" ? m.mcp_error_request() : m.mcp_error_other()}</p>
    <p>{before}<a href={CONNECT_MD_PATH} className="underline"><code>{CONNECT_MD_PATH}</code></a>{after}</p>
    <p><Link to="/" className="underline ui-help">{m.confirm_home()}</Link></p>
  </main></>;
}
