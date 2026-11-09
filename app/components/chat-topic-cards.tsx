import { Link } from "react-router";
import type { ChatTopicCard } from "~/lib/village-chat";
import { m } from "~/paraglide/messages.js";

export function ChatTopicCards({ topics, tabIndex }: { tabIndex?: number; topics?: readonly ChatTopicCard[] }) {
  if (!topics?.length) return null;
  return <ul className="mt-2 space-y-2" data-chat-topics>{topics.map(topic => <li key={topic.id} className="rounded border p-2 text-sm">
    <Link tabIndex={tabIndex} to={topic.href} lang={topic.lang} className={`block underline ${topic.fromBody ? "font-normal" : "font-semibold"}`}>{topic.title}</Link>
    <div className="mt-1 flex flex-wrap gap-3 ui-meta"><span>{m.home_replies({ count: topic.replyCount })}</span><Link tabIndex={tabIndex} to={topic.replyHref} className="underline">{m.village_chat_topic_reply()}</Link></div>
  </li>)}</ul>;
}
