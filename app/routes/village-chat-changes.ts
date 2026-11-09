import type { Route } from "./+types/village-chat-changes";
import { CHAT_PRIVATE_HEADERS, chatResourceMember } from "~/lib/village-chat-auth.server";
import { chatSequence } from "~/lib/village-chat";
import { ChatError, chatChanges } from "~/lib/village-chat.server";
import { displayLangFor, langQueryParam, screenReadLangsFor } from "~/lib/display-lang.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { db, user, profile } = await chatResourceMember(request, params.slug, "chat-changes");
  const search = new URL(request.url).searchParams;
  const since = chatSequence(search.get("since") ?? "0");
  const before = search.has("before") ? chatSequence(search.get("before")) : undefined;
  const after = search.has("after") ? chatSequence(search.get("after")) : undefined;
  const forward = search.has("forward") ? chatSequence(search.get("forward")) : undefined;
  if (forward === null || before !== undefined && forward !== undefined || since === null || before === null || after === null) throw new Response("Bad request", { status: 400, headers: CHAT_PRIVATE_HEADERS });
  try { return Response.json(await chatChanges(db, user.id, params.slug, { since, before, after, forward, counts: search.get("counts") === "1", topics: { displayLang: displayLangFor(request, profile), readLangs: screenReadLangsFor(request, profile), langParam: langQueryParam(request) } }), { headers: CHAT_PRIVATE_HEADERS }); }
  catch (error) { if (error instanceof ChatError) throw new Response("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS }); throw error; }
}
