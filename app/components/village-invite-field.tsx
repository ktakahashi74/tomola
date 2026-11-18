import { lazy, Suspense, useId, useRef, useState } from "react";
import { m } from "~/paraglide/messages.js";
import { Input } from "./ui/input";

const Autocomplete = lazy(() => import("./village-invite-autocomplete"));

export function VillageInviteField({ slug }: { slug: string }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [enabled, setEnabled] = useState(false);
  return <>
    <label htmlFor={id} className="block">{m.village_invite_handle()}</label>
    <div className="relative">
      <Input id={id} ref={input} name="handle" required autoComplete="off" aria-describedby={`${id}-help`} onFocus={() => setEnabled(true)} />
      {enabled && <Suspense fallback={null}><Autocomplete input={input} slug={slug} /></Suspense>}
    </div>
    <p id={`${id}-help`} className="ui-help text-muted-foreground">{m.village_invite_member_help()} {m.village_invite_suggest_help()}</p>
  </>;
}
