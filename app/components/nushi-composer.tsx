import { useEffect, useRef, useState } from "react";
import { m } from "~/paraglide/messages.js";

export function NushiComposerNotice() {
  const ref = useRef<HTMLDivElement>(null);
  const [calling, setCalling] = useState(false);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const inspect = () => {
      clearTimeout(timer); controller?.abort();
      const data = new FormData(form), body = String(data.get("body") ?? "");
      if (!/[@＠](?:nushi|village-ai)/iu.test(body)) { setCalling(false); return; }
      timer = setTimeout(async () => {
        controller = new AbortController();
        const signal = controller.signal;
        const thread = /\/t\/(\d+)/.exec(window.location.pathname)?.[1];
        const params = new URLSearchParams(thread ? { thread } : { village: String(data.get("village") ?? "") });
        try {
          const place = await fetch(`/nushi/availability?${params}`, { signal });
          if (!place.ok || !(await place.json()).available) { if (!signal.aborted) setCalling(false); return; }
          const parsed = await fetch("/nushi/availability", { method: "POST", body: data, signal });
          if (parsed.ok && !signal.aborted) setCalling((await parsed.json()).calls === true);
        } catch { /* A stale request never changes the notice. */ }
      }, 250);
    };
    form.addEventListener("input", inspect); form.addEventListener("change", inspect); inspect();
    return () => { clearTimeout(timer); controller?.abort(); form.removeEventListener("input", inspect); form.removeEventListener("change", inspect); };
  }, []);
  return <div ref={ref}>{calling && <div className="space-y-1 rounded border p-2 ui-help"><p>{m.nushi_call_notice()}</p></div>}</div>;
}
