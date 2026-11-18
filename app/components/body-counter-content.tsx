import { useEffect, useRef, useState } from "react";
import { bodyLength, bodyLimit, bodyWithinLimits, MAX_BODY_BYTES, type BodyKind } from "~/lib/body-length";
import { bodyLimitMessage } from "~/lib/entry-error-message";
import { QUOTE_REFUSED_EVENT } from "~/lib/quote-events";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

// Put inside a writing form. The body is never cut at the limit: the characters left are shown close to it, and past it the count that is too many is shown
// and the form refuses to send (the text stays). Also tells that a quotation was refused because it would go over the limit.
export default function BodyCounterContent() {
  const holder = useRef<HTMLDivElement>(null);
  const [length, setLength] = useState(0);
  const [kind, setKind] = useState<BodyKind>("topic");
  const [bytesOver, setBytesOver] = useState(false);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    const body = holder.current?.closest("form")?.elements.namedItem("body");
    if (!(body instanceof HTMLTextAreaElement)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const kind = body.dataset.bodyKind === "reply" ? "reply" : "topic";
      const length = bodyLength(body.value, kind);
      const bytesOver = new TextEncoder().encode(body.value).byteLength > MAX_BODY_BYTES;
      setKind(kind);
      setLength(length);
      setBytesOver(bytesOver);
      body.setCustomValidity(bodyWithinLimits(body.value, kind) ? "" : bodyLimitMessage(kind, bytesOver && length <= bodyLimit(kind)));
    };
    const refuse = () => { setRefused(true); clearTimeout(timer); timer = setTimeout(() => setRefused(false), 6000); };
    update();
    body.addEventListener("input", update);
    body.addEventListener(QUOTE_REFUSED_EVENT, refuse);
    return () => { clearTimeout(timer); body.removeEventListener("input", update); body.removeEventListener(QUOTE_REFUSED_EVENT, refuse); };
  }, []);
  const limit = bodyLimit(kind), over = length - limit;
  const count = Math.abs(over).toLocaleString(getLocale());
  return <div ref={holder} className="empty:hidden">
    {kind === "topic" && <p className="ui-help text-muted-foreground">{m.topic_body_limit_hint()}</p>}
    {length >= Math.floor(limit * 0.9) && <p role="status" className={`ui-help ${over > 0 ? "text-destructive" : "text-muted-foreground"}`}>{over > 0 ? kind === "topic" ? m.topic_body_count_over({ count }) : m.body_count_over({ count }) : m.body_count_left({ count })}</p>}
    {bytesOver && over <= 0 && <p role="status" className="ui-help text-destructive">{m.error_body_too_many_special_characters()}</p>}
    {refused && <p role="status" className="ui-help text-destructive">{m.quote_over_limit()}</p>}
  </div>;
}
