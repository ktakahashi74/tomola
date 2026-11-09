import { useEffect, useRef, useState } from "react";
import { BODY_MAX_LENGTH } from "~/lib/rich-editor";
import { QUOTE_REFUSED_EVENT } from "~/lib/quote-events";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

const NEAR_LIMIT = Math.floor(BODY_MAX_LENGTH * 0.9);

// Put inside a writing form. The body is never cut at the limit: the characters left are shown close to it, and past it the count that is too many is shown
// and the form refuses to send (the text stays). Also tells that a quotation was refused because it would go over the limit.
export default function BodyCounterContent() {
  const holder = useRef<HTMLDivElement>(null);
  const [length, setLength] = useState(0);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    const body = holder.current?.closest("form")?.elements.namedItem("body");
    if (!(body instanceof HTMLTextAreaElement)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      setLength(body.value.length);
      body.setCustomValidity(body.value.length > BODY_MAX_LENGTH ? m.error_body_too_long() : "");
    };
    const refuse = () => { setRefused(true); clearTimeout(timer); timer = setTimeout(() => setRefused(false), 6000); };
    update();
    body.addEventListener("input", update);
    body.addEventListener(QUOTE_REFUSED_EVENT, refuse);
    return () => { clearTimeout(timer); body.removeEventListener("input", update); body.removeEventListener(QUOTE_REFUSED_EVENT, refuse); };
  }, []);
  const over = length - BODY_MAX_LENGTH;
  return <div ref={holder} className="empty:hidden">
    {length >= NEAR_LIMIT && <p role="status" className={`ui-help ${over > 0 ? "text-destructive" : "text-muted-foreground"}`}>{over > 0 ? m.body_count_over({ count: over.toLocaleString(getLocale()) }) : m.body_count_left({ count: (BODY_MAX_LENGTH - length).toLocaleString(getLocale()) })}</p>}
    {refused && <p role="status" className="ui-help text-destructive">{m.quote_over_limit()}</p>}
  </div>;
}
