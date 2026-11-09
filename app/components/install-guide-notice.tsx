import { useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { dismissInstallGuide, promptInstall } from "~/lib/use-install-guide";
import { m } from "~/paraglide/messages.js";
import { InstallGuideSteps } from "./install-guide-steps";

export default function InstallGuideNotice({ mode, failed, onFailure }: { mode: "ios" | "prompt"; failed: boolean; onFailure: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();
  const notice = useRef<HTMLDivElement>(null);
  function dismiss() {
    const inside = notice.current?.contains(document.activeElement);
    if (inside) {
      const next = notice.current?.nextElementSibling;
      if (next instanceof HTMLElement) {
        next.tabIndex = -1;
        next.addEventListener("blur", () => next.removeAttribute("tabindex"), { once: true });
        next.focus({ preventScroll: true });
      }
    }
    dismissInstallGuide();
  }
  return <div ref={notice} data-install-guide className="relative rounded-lg border bg-muted p-4 pe-14 space-y-3">
    <Button type="button" variant="ghost" size="icon" className="absolute end-1 top-1 size-11" aria-label={m.install_guide_dismiss()} onClick={dismiss}><X aria-hidden="true" /></Button>
    <p>{m.install_guide_intro()}</p>
    {mode === "ios" ? <>
      <Button type="button" variant="outline" className="h-auto min-h-11 whitespace-normal" aria-expanded={expanded} aria-controls={stepsId} onClick={() => setExpanded(value => !value)}>{m.install_guide_steps()}</Button>
      <div id={stepsId} hidden={!expanded}><InstallGuideSteps /></div>
      <p className="ui-help text-muted-foreground">{m.install_guide_existing()}</p>
    </> : !failed && <Button type="button" variant="outline" className="h-auto min-h-11 whitespace-normal" onClick={() => { void promptInstall().catch(onFailure); }}>{m.install_guide_add()}</Button>}
    {failed && <p role="status" className="ui-help">{m.install_guide_retry()}</p>}
  </div>;
}
