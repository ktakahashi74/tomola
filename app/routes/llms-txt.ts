import type { Route } from "./+types/llms-txt";
import { aiTxt, GUIDE_CONTENT_TYPE, helpAiMd, llmsTxt } from "~/lib/api/guides.server";
import { publicResponse } from "~/lib/api/http.server";
import { openApiDocument } from "~/lib/api/openapi.server";

// Public guidance without member content or authentication: /llms.txt, /ai.txt, /help/ai.md, /api/openapi.json.
// All four routes share this module, distinguished by path.
export async function loader({ request }: Route.LoaderArgs) {
  const path = new URL(request.url).pathname;
  if (path === "/ai.txt") return publicResponse(request, aiTxt(), GUIDE_CONTENT_TYPE);
  if (path === "/help/ai.md") return publicResponse(request, helpAiMd(), GUIDE_CONTENT_TYPE);
  if (path === "/api/openapi.json") return publicResponse(request, JSON.stringify(openApiDocument(), null, 2), "application/json; charset=utf-8");
  return publicResponse(request, llmsTxt(), GUIDE_CONTENT_TYPE);
}
