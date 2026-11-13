import { data } from "react-router";
import type { Route } from "./+types/post-ask-ai-action";
import { requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { postAskAiEnabled } from "~/lib/ai-question-config.server";
import { displayLangFor } from "~/lib/display-lang.server";
import { parseId } from "~/lib/params.server";
import { handlePostQuestion, questionJson } from "~/lib/post-ask-ai.server";

export const middleware = [privateCacheMiddleware];
export const loader = () => questionJson({ error: "not_found" }, 405, { Allow: "POST" });

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return questionJson({ error: "invalid" }, 405, { Allow: "POST" });
  assertSameOrigin(request);
  if (!postAskAiEnabled()) throw data("Not found", { status: 404 });
  const { db, user, profile } = await requireWriter(request);
  return handlePostQuestion(db, user.id, parseId(params.id), displayLangFor(request, profile), request);
}
