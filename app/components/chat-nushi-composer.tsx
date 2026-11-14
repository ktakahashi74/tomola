import { useEffect, useRef, useState } from "react";
import { m } from "~/paraglide/messages.js";

export function ChatNushiComposer({ slug }: { slug: string }) {
  const ref = useRef<HTMLDivElement>(null), [calling, setCalling] = useState(false);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    let timer: ReturnType<typeof setTimeout>, controller: AbortController | undefined;
    const inspect = () => {
      clearTimeout(timer); controller?.abort();
      const body = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value ?? "";
      if (!/[@＠](?:nushi|village-ai)/iu.test(body)) { setCalling(false); return; }
      setCalling(true);
      timer = setTimeout(async () => {
        controller = new AbortController(); const signal = controller.signal;
        try {
          const response = await fetch(`/v/${slug}/chat/nushi`, { method: "POST", body: new URLSearchParams({ body }), signal });
          const calls = response.ok && (await response.json()).calls === true;
          if (!signal.aborted) setCalling(calls);
        } catch { /* An obsolete request never changes the notice. */ }
      }, 200);
    };
    form.addEventListener("input", inspect); inspect();
    return () => { clearTimeout(timer); controller?.abort(); form.removeEventListener("input", inspect); };
  }, [slug]);
  return <div ref={ref} className="basis-full">{calling && <div className="space-y-1 rounded border p-2 ui-help"><p>{m.chat_nushi_call_notice()}</p><label><input type="checkbox" name="suppressNushi" value="1" /> {m.nushi_suppress()}</label></div>}</div>;
}
