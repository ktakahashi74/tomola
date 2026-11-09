import { useEffect, useState } from "react";
import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";

// The daily digest goes out at 00:00 UTC. Say that time in the reader's own clock once the page is in the browser; until then, in UTC.
export function DigestTime() {
  const [time, setTime] = useState("00:00 UTC");
  useEffect(() => {
    const now = new Date();
    // Today's 00:00 UTC, so that daylight-saving time is the reader's current one.
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    setTime(new Intl.DateTimeFormat(getLocale(), { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at));
  }, []);
  return <>{m.settings_email_digest_at({ time })}</>;
}
