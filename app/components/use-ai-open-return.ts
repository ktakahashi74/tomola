import { useEffect, useRef, useState } from "react";
import { aiOpenLinkExpiresAt, AI_OPEN_CHECK_DELAY_MS, AI_OPEN_CHECK_INTERVAL_MS } from "~/lib/open-in-ai";

// Only component memory holds the link; reset on navigation, another click, or menu
// use. Cleanup cancels pending work so an old response cannot affect a new attempt.
export function useAiOpenReturn(resource: string) {
  const [attempt, setAttempt] = useState<{ id: number; url: string; notBefore: number; expiresAt: number } | null>(null);
  const [notRead, setNotRead] = useState(false);
  const generation = useRef(0);
  function reset() { setAttempt(null); setNotRead(false); return ++generation.current; }
  function start(url: string, clickedAt: number, id: number) {
    const expiresAt = aiOpenLinkExpiresAt(url);
    if (id === generation.current && expiresAt !== null) setAttempt({ id, url, notBefore: clickedAt + AI_OPEN_CHECK_DELAY_MS, expiresAt });
  }
  useEffect(() => { reset(); return () => { generation.current++; }; }, [resource]);
  useEffect(() => {
    if (!attempt || attempt.id !== generation.current) return;
    let live = true;
    let done = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    function schedule(at: number) {
      clearTimeout(timer);
      timer = setTimeout(() => void check(), Math.max(0, Math.min(at, attempt!.expiresAt) - Date.now()));
    }
    async function check() {
      if (!live || done || attempt!.id !== generation.current) return;
      if (Date.now() >= attempt!.expiresAt) { done = true; controller.abort(); return; }
      if (document.visibilityState !== "visible") { schedule(attempt!.expiresAt); return; }
      if (Date.now() < attempt!.notBefore) { schedule(attempt!.notBefore); return; }
      if (inFlight) return;
      inFlight = true;
      schedule(attempt!.expiresAt);
      try {
        const body = new URLSearchParams({ url: attempt!.url });
        const response = await fetch("/open-in-ai/status", { method: "POST", body, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal });
        if (!response.ok) return;
        const result = await response.json() as { read?: unknown };
        if (!live || done || attempt!.id !== generation.current || Date.now() >= attempt!.expiresAt) return;
        if (result.read === true) { done = true; reset(); }
        else if (result.read === false) setNotRead(true);
      } catch { /* A failed check cannot establish that the AI has not read. */ }
      finally {
        inFlight = false;
        if (live && !done && attempt!.id === generation.current) schedule(Date.now() + AI_OPEN_CHECK_INTERVAL_MS);
      }
    }
    const visible = () => void check();
    document.addEventListener("visibilitychange", visible);
    schedule(attempt.notBefore);
    return () => { live = false; clearTimeout(timer); controller.abort(); document.removeEventListener("visibilitychange", visible); };
  }, [attempt]);
  return { notRead, start, reset };
}
