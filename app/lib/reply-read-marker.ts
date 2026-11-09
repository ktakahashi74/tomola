import { rememberViewingReplies, type ReplyReadView } from "~/lib/seen-replies";
import { afterInitialActivation } from "~/lib/initial-activation";
import { openReplyTail } from "~/lib/reply-branches-browser";
import { m } from "~/paraglide/messages.js";

// Browser-only additions leave the server-rendered replies and forms intact.
// Keep the position of the anchor the reader came to while the marks are added: the summary row can change the height above it.
export function markNewReplies(threadId: number, replies: readonly { id: number; placeholder: string | null; hidden?: boolean; own?: boolean }[], view: ReplyReadView): () => void {
  let ids: number[];
  try { ids = rememberViewingReplies(window.localStorage, threadId, replies.map(r => ({ id: r.id, eligible: r.placeholder === null && !r.hidden && !r.own })), view); } catch { return () => {}; }
  const elements = ids.map(id => document.getElementById(`c-${id}`)).filter((node): node is HTMLElement => node !== null);
  const list = document.querySelector<HTMLElement>("[data-reply-list]");
  if (!elements.length || !list) return () => {};
  const additions: HTMLElement[] = [];
  const marked: HTMLElement[] = [];
  const cancel = afterInitialActivation(() => {
    const anchor = document.getElementById(window.location.hash.slice(1));
    const top = anchor?.getBoundingClientRect().top;
    for (const reply of elements) {
      openReplyTail(reply, true);
      // A new reply gets a thin line on its left (drawn by the attribute, in app/app.css) and a small dot before its name; no row of text is added to it.
      reply.dataset.newReply = "";
      marked.push(reply);
      const dot = document.createElement("span");
      dot.dataset.newReplyDot = "";
      const mark = document.createElement("span");
      mark.setAttribute("aria-hidden", "true");
      mark.className = "me-1.5 inline-block size-2 rounded-full bg-info-emphasis align-baseline";
      const label = document.createElement("span");
      label.className = "sr-only";
      label.textContent = `${m.reply_new()} `;
      dot.append(mark, label);
      (reply.querySelector("[id^='reply-meta-']") ?? reply).prepend(dot);
      additions.push(dot);
    }
    // The count and the link to the first new reply go into the row of the page's moves (in front of "Go to the latest reply"), so that there is one line, not two.
    const summary = document.createElement("span");
    summary.dataset.newReplies = "";
    summary.className = "inline-flex flex-wrap gap-x-3 [overflow-wrap:anywhere]";
    const count = document.createElement("span");
    count.textContent = m.page_new_replies({ count: elements.length });
    const link = document.createElement("a");
    link.href = `#${elements[0].id}`;
    link.className = "underline";
    link.textContent = m.first_new_reply();
    summary.append(count, link);
    const row = document.querySelector<HTMLElement>("[data-reply-summary]");
    if (row) row.prepend(summary); else list.prepend(summary);
    additions.push(summary);
    if (anchor && top !== undefined) window.scrollBy(0, anchor.getBoundingClientRect().top - top);
  });
  return () => { cancel(); additions.forEach(node => node.remove()); marked.forEach(reply => delete reply.dataset.newReply); };
}
