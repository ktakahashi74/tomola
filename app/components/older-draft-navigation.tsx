import { m } from "~/paraglide/messages.js";

export default function OlderDraftNavigation({ count, next }: { count: number; next: () => void }) {
  return <> <span>{m.local_draft_count({ count })}</span> <button type="button" className="underline" onClick={next}>{m.local_draft_next()}</button></>;
}
