import type { Route } from "./+types/connect-md";
import { connectMarkdown, connectPlan } from "~/lib/api/connect.server";
import { GUIDE_CONTENT_TYPE } from "~/lib/api/guides.server";
import { methodNotAllowed, publicResponse } from "~/lib/api/http.server";
import { mdBlock } from "~/lib/md/frontmatter.server";

// /connect.md and /connect.txt: the steps for an AI tool that its user has asked to connect to this site. Public, no member content, no credentials. Made from the
// same plan as /connect, /help/mcp.md and /help/ai.md (app/lib/api/connect.server.ts).
export function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  const plan = connectPlan();
  const body = mdBlock({ type: "page", id: "connect", lang: "en", canonical: plan.connectUrl }, connectMarkdown(plan));
  const response = publicResponse(request, body, GUIDE_CONTENT_TYPE);
  // Public, but not indexable, like the other documents.
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}
