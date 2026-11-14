import { chatNushiEnabled, chatNushiInVillage } from "~/lib/chat-nushi-config.server";
import { chatResourceMember, CHAT_PRIVATE_HEADERS } from "~/lib/village-chat-auth.server";
import { callsNushi } from "~/lib/nushi-call.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { CHAT_BODY_MAX } from "~/lib/village-chat";
import type { Route } from "./+types/village-chat-nushi";

export async function action({ request, params }: Route.ActionArgs) {
  if (!chatNushiEnabled()) throw new Response("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS });
  assertSameOrigin(request);
  const { village } = await chatResourceMember(request, params.slug, "chat-nushi-preview");
  if (!chatNushiInVillage(village)) throw new Response("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS });
  const form = await request.formData(), body = form.get("body");
  return Response.json({ calls: typeof body === "string" && body.length <= CHAT_BODY_MAX && await callsNushi(body) }, { headers: CHAT_PRIVATE_HEADERS });
}

export function loader() { throw new Response("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS }); }
