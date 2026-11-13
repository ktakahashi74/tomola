import { Link } from "react-router";
import type { ChatReply } from "~/lib/village-chat";
import { m } from "~/paraglide/messages.js";

export function ChatReplyLine({ reply, slug, createdAt, tabIndex }: { reply?: ChatReply | null; slug: string; createdAt: string; tabIndex?: number }) {
  if (!reply) return null;
  if (reply.unavailable) return <p data-chat-reply className="truncate border-s-2 ps-2 ui-meta text-muted-foreground">{m.village_chat_reply_unavailable()}</p>;
  return <Link data-chat-reply tabIndex={tabIndex} to={`/v/${slug}/chat?at=${reply.id}#chat-${reply.id}`} className="block truncate border-s-2 ps-2 ui-meta text-muted-foreground underline" lang={reply.lang} title={reply.text}>
    <bdi>{reply.authorName || `@${reply.author}`}</bdi>{": "}{reply.text}{reply.editedAt && reply.editedAt > createdAt && <> {m.village_chat_edited()}</>}
  </Link>;
}
