import { afterInitialActivation } from "~/lib/initial-activation";

export function openReplyTail(reply: HTMLElement, preserveChoice = false): boolean {
  const details = reply.closest<HTMLDetailsElement>("details[data-reply-tail]");
  if (!details || details.open || (preserveChoice && details.hasAttribute("data-reply-manual"))) return false;
  details.open = true;
  return true;
}

// Fragments never reach the server. Native details remain operable without JS;
// with JS, also reveal targets on initial load, hash changes and history travel.
export function attachReplyBranchAnchors(root: HTMLElement, preserveInitialChoice = true): () => void {
  let cancel = () => {};
  let firstReveal = true;
  const reveal = (event?: Event) => {
    cancel();
    cancel = afterInitialActivation(() => {
      const reply = /^#c-[1-9]\d*$/.test(window.location.hash) ? document.getElementById(window.location.hash.slice(1)) : null;
      const details = reply?.closest<HTMLDetailsElement>("details[data-reply-tail]");
      const initiallyQueryOpened = firstReveal && !event && preserveInitialChoice && details?.open
        && details.dataset.replyInitialQuery === reply?.id.slice(2);
      firstReveal = false;
      // Consume the SSR-only marker once, including when the initial fragment
      // points elsewhere. History/pageshow must never repeat that initial move.
      root.querySelectorAll<HTMLElement>("[data-reply-initial-query]").forEach(element => { delete element.dataset.replyInitialQuery; });
      if (!reply || !root.contains(reply)) return;
      if (!details) return;
      const preserveChoice = !event && preserveInitialChoice;
      if (preserveChoice && details && !details.open && details.hasAttribute("data-reply-manual")) return;
      if (openReplyTail(reply, preserveChoice) || initiallyQueryOpened) reply.scrollIntoView();
    });
  };
  reveal();
  const rememberToggle = (event: Event) => {
    const summary = event.target instanceof Element ? event.target.closest("summary") : null;
    const details = summary?.parentElement;
    if (details?.matches("details[data-reply-tail]")) details.dataset.replyManual = "";
  };
  root.addEventListener("click", rememberToggle);
  window.addEventListener("hashchange", reveal);
  window.addEventListener("popstate", reveal);
  window.addEventListener("pageshow", reveal);
  return () => {
    cancel();
    root.removeEventListener("click", rememberToggle);
    window.removeEventListener("hashchange", reveal);
    window.removeEventListener("popstate", reveal);
    window.removeEventListener("pageshow", reveal);
  };
}
