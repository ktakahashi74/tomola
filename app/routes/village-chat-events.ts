import type { Route } from "./+types/village-chat-events";
import { CHAT_PRIVATE_HEADERS, chatResourceMember } from "~/lib/village-chat-auth.server";
import { closeVillageChatConnections, villageChatEventStream } from "~/lib/village-chat-events.server";
import { chatAccess, currentChatSequence } from "~/lib/village-chat.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { db, user, village } = await chatResourceMember(request, params.slug, "chat-events");
  const response = villageChatEventStream(village.id, user.id, await currentChatSequence(db, village.id), request.signal);
  if (response.status !== 200) return response;
  // Register before rechecking: a leave committed during connection setup must also close it.
  if (!(await chatAccess(db, params.slug, user.id))?.consented) {
    closeVillageChatConnections(village.id, user.id);
    throw new Response("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS });
  }
  // Catch a commit between the first horizon read and registration without broadcasting to other tabs.
  // The client immediately fetches changes on open, so every intervening commit is retrieved.
  return response;
}
