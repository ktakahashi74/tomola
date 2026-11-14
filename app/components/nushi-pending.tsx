import { m } from "~/paraglide/messages.js";

export function NushiPending() {
  return <>{m.nushi_pending()}<span aria-hidden="true" className="nushi-pending-dots"><span>.</span><span>.</span><span>.</span></span></>;
}
