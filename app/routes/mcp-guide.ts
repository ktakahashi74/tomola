import { mcpConnectionGuide } from "~/lib/mcp/guide.server";
import type { Route } from "./+types/mcp-guide";
export function loader({ request }: Route.LoaderArgs) {
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  return new Response(request.method === "HEAD" ? null : mcpConnectionGuide(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
