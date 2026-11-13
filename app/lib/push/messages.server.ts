import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";

export function pushMessage(kind: string, locale: Locale, grouped = false): string {
  const options = { locale };
  if (grouped) return m.push_message_group({}, options);
  if (kind === "reply_to_topic" || kind === "reply_to_reply" || kind === "chat_reply") return m.push_message_reply({}, options);
  if (kind === "response_to_topic") return m.push_message_response({}, options);
  if (kind === "mention" || kind === "chat_mention") return m.push_message_mention({}, options);
  return m.push_message_test({}, options);
}
