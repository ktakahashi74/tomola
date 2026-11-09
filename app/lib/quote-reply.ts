import { m } from "~/paraglide/messages.js";
import { BODY_MAX_LENGTH } from "~/lib/rich-editor";
import { QUOTE_REFUSED_EVENT } from "~/lib/quote-events";

const MAX_QUOTE_CHARACTERS = 1000;

export function markdownQuote(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map(line => `> ${line}`).join("\n");
}

// The line that says where a quotation comes from, with a link back to it. A quotation taken from a machine translation says so, because the author of the quoted post
// did not write those words. The handle is written without "@" so that quoting does not mention (and notify) the quoted member.
// A reply is on one page of the thread (?page=); the address names the page it is on now, or the link would land nowhere from another page.
export function quoteSource(entry: { kind: string; id: string; handle: string; translated: boolean }, threadId: string | null, page = 1): string | null {
  if (!threadId || !/^\d+$/.test(entry.id) || !entry.handle) return null;
  const topic = entry.kind === "topic";
  const label = (topic ? m.quote_source_topic : m.quote_source_reply)({ handle: entry.handle }) + (entry.translated ? m.quote_source_machine() : "");
  const query = !topic && page > 1 ? `?page=${page}` : "";
  return `— [${label.replace(/[\[\]\\]/g, "\\$&")}](/t/${threadId}${query}#${topic ? "p" : "c"}-${entry.id})`;
}

function currentPage(): number {
  const page = new URLSearchParams(window.location.search).get("page") ?? "";
  return /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1;
}

// Loaded on the first selection gesture by a member who can reply. Keep the
// existing uncontrolled textarea and dispatch input for previews and signing.
export function attachQuoteReply(root: HTMLElement, setReplyTarget: (id: number) => void): () => void {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = m.quote_reply();
  button.className = "fixed z-50 inline-flex min-h-8 items-center justify-center rounded-lg bg-primary px-3 py-1 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  button.hidden = true;
  root.append(button);
  const selected = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const body = element?.closest<HTMLElement>("[data-quote-entry]");
    if (!body || !root.contains(body) || !body.contains(range.endContainer)) return null;
    const text = selection.toString().trim();
    if (!text || Array.from(text).length > MAX_QUOTE_CHARACTERS) return null;
    return { body, text, range, element };
  };
  const update = () => {
    const selection = selected();
    button.hidden = !selection;
    if (!selection) return;
    const rects = [...selection.range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    const rect = rects[0];
    if (!rect) { button.hidden = true; return; }
    const start = getComputedStyle(selection.element!).direction === "rtl" ? rect.right - button.offsetWidth : rect.left;
    const left = Math.max(8, Math.min(start, window.innerWidth - button.offsetWidth - 8));
    const height = button.offsetHeight;
    const obstacles = [...root.querySelectorAll<HTMLElement>("button, a, summary, input, textarea, select")]
      .filter(element => element !== button).map(element => element.getBoundingClientRect())
      .filter(box => box.width > 0 && box.height > 0 && box.right > left && box.left < left + button.offsetWidth);
    // Prefer the space above the selection. If controls occupy it, try the
    // other side or an edge of those controls without covering any action.
    const candidates = [rect.top - height - 6, rects.at(-1)!.bottom + 6, ...obstacles.flatMap(box => [box.top - height - 6, box.bottom + 6])];
    const top = candidates.find(y => y >= 8 && y + height <= window.innerHeight - 8 &&
      rects.every(box => y + height <= box.top || y >= box.bottom || left + button.offsetWidth <= box.left || left >= box.right) &&
      obstacles.every(box => y + height <= box.top || y >= box.bottom));
    button.hidden = top === undefined;
    if (top === undefined) return;
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
  };
  // Preserve the range when a pointer press would otherwise clear the selection.
  button.addEventListener("pointerdown", event => event.preventDefault());
  button.addEventListener("click", () => {
    const selection = selected();
    const textarea = root.querySelector<HTMLTextAreaElement>('#reply textarea[name="body"]');
    if (!selection || !textarea) return;
    const source = quoteSource({ kind: selection.body.dataset.quoteKind ?? "", id: selection.body.dataset.quoteEntry ?? "", handle: selection.body.dataset.quoteHandle ?? "", translated: selection.body.dataset.quoteTranslated === "1" },
      /^\/t\/(\d+)(?:\/|$)/.exec(window.location.pathname)?.[1] ?? null, currentPage());
    const quote = markdownQuote(selection.text) + (source ? `\n>\n> ${source}` : "");
    const value = textarea.value + (textarea.value ? "\n\n" : "") + quote + "\n\n";
    // Say so instead of silently doing nothing when the quotation would take the body past its limit.
    if (value.length > BODY_MAX_LENGTH) { textarea.dispatchEvent(new Event(QUOTE_REFUSED_EVENT)); return; }
    if (selection.body.dataset.quoteKind === "reply") setReplyTarget(Number(selection.body.dataset.quoteEntry));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    window.getSelection()?.removeAllRanges();
    button.hidden = true;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(value.length, value.length);
    textarea.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  document.addEventListener("selectionchange", update);
  window.addEventListener("scroll", update, true);
  window.addEventListener("resize", update);
  update();
  return () => {
    document.removeEventListener("selectionchange", update);
    window.removeEventListener("scroll", update, true);
    window.removeEventListener("resize", update);
    button.remove();
  };
}
