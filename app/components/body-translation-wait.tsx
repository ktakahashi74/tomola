import { useEffect, useEffectEvent, useState } from "react";
import { useRevalidator } from "react-router";
import { PendingText } from "~/components/pending-text";
import { useTranslationWait } from "~/lib/translation-wait";
import { m } from "~/paraglide/messages.js";

export const BODY_TRANSLATION_POLL_MS = 3000;
export const BODY_TRANSLATION_WAIT_MS = 120_000;
type State = "idle" | "working" | "stopped" | "finished";
type Listener = { state: (value: State) => void; ready: () => Promise<void> };
// One coordinator per mounted topic page. Every visible post joins before the
// first request, so both requests and polling are batched.
let batch: { page: string; listeners: Map<number, Listener>; timer?: ReturnType<typeof setTimeout>; controller: AbortController; deadline?: ReturnType<typeof setTimeout>; until: number; requested: Set<number> } | undefined;
function join(entryId: number, listener: Listener): () => void {
  const page = location.pathname + location.search;
  if (!batch || batch.page !== page) { batch?.controller.abort(); clearTimeout(batch?.timer); clearTimeout(batch?.deadline); batch = { page, listeners: new Map(), controller: new AbortController(), until: Date.now() + BODY_TRANSLATION_WAIT_MS, requested: new Set() }; }
  const current = batch;
  current.deadline ??= setTimeout(() => {
    for (const l of current.listeners.values()) l.state("finished");
    clearTimeout(current.timer); current.controller.abort();
  }, Math.max(0, current.until - Date.now()));
  current.listeners.set(entryId, listener);
  const finish = (value: State) => { for (const l of current.listeners.values()) l.state(value); };
  const tick = async () => {
    if (current.controller.signal.aborted || !current.listeners.size) return;
    if (Date.now() >= current.until) { finish("finished"); return; }
    if (document.visibilityState === "visible") {
      const ids = [...current.listeners.keys()];
      const fresh = ids.filter(id => !current.requested.has(id));
      const intent = fresh.length ? "request" : "status";
      try {
        const response = await fetch(`${location.pathname}/translations${location.search}`, { method: "POST", credentials: "same-origin", redirect: "error", signal: current.controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent, ids: fresh.length ? fresh : ids }) });
        if (!response.ok) { finish("finished"); return; }
        const result = await response.json() as { stopped?: boolean; ready: number[]; unavailable: number[] };
        fresh.forEach(id => current.requested.add(id));
        const settled = [...result.ready, ...result.unavailable];
        if (settled.length) {
          // Revalidation preserves navigation, drafts and scroll. Anchor the first
          // visible post too, since translated text can have a different height.
          const anchor = [...document.querySelectorAll("article[id]")].find(p => p.getBoundingClientRect().bottom > 0);
          const top = anchor?.getBoundingClientRect().top;
          for (const id of settled) current.listeners.get(id)?.state("finished");
          const ready = current.listeners.get(settled[0])?.ready;
          settled.forEach(id => current.listeners.delete(id));
          if (ready) {
            await ready();
            if (location.pathname + location.search !== current.page) return;
            if (anchor && top !== undefined) {
              const replacement = document.getElementById(anchor.id);
              if (replacement) window.scrollBy(0, replacement.getBoundingClientRect().top - top);
            }
            if (result.ready.length) {
              const announce = document.createElement("span"); announce.className = "sr-only"; announce.setAttribute("role", "status"); document.body.append(announce);
              setTimeout(() => { announce.textContent = m.translation_arrived(); }, 100);
              setTimeout(() => announce.remove(), 3000);
            }
          }
        }
        if (result.stopped) { finish("stopped"); return; }
      } catch { if (current.controller.signal.aborted) return; }
    }
    if (current.listeners.size) current.timer = setTimeout(tick, Math.min(BODY_TRANSLATION_POLL_MS, Math.max(0, current.until - Date.now())));
  };
  if (current.timer === undefined) current.timer = setTimeout(tick, 0);
  return () => {
    current.listeners.delete(entryId);
    if (!current.listeners.size) { clearTimeout(current.timer); clearTimeout(current.deadline); current.controller.abort(); if (batch === current) batch = undefined; }
  };
}
export default function BodyTranslationWait({ entryId }: { entryId: number }) {
  const wait = useTranslationWait("posts");
  const [state, setState] = useState<State>(wait.kind === "stopped" ? "stopped" : "idle");
  const revalidator = useRevalidator();
  const ready = useEffectEvent(async () => { await revalidator.revalidate(); });
  useEffect(() => {
    if (wait.kind === "stopped") { setState("stopped"); return; }
    setState("working");
    return join(entryId, { state: setState, ready });
  }, [entryId, wait.kind]);
  if (state === "idle") return <PendingText short />;
  return state === "finished" ? null : <span role="status" className="ui-meta text-muted-foreground">{state === "stopped" ? m.label_no_translation() : <><span aria-hidden="true">{m.translation_working()}</span><span className="sr-only">{m.translation_working_accessible()}</span></>}</span>;
}
