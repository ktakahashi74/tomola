import { useState } from "react";
import { Button } from "~/components/ui/button";
import { useInstallGuide, promptInstall } from "~/lib/use-install-guide";
import { m } from "~/paraglide/messages.js";
import { InstallGuideSteps } from "./install-guide-steps";

export function InstallGuideSettings() {
  const state = useInstallGuide();
  const [failed, setFailed] = useState(false);
  return <section id="settings-install" aria-labelledby="settings-install-heading" className="scroll-mt-4 space-y-3">
    <h3 id="settings-install-heading" className="text-lg font-semibold">{m.install_guide_add()}</h3>
    <p className="ui-help text-muted-foreground">{m.install_guide_intro()}</p>
    <h4 className="font-medium">{m.install_guide_ios()}</h4>
    <InstallGuideSteps />
    <p className="ui-help text-muted-foreground">{m.install_guide_existing()}</p>
    <h4 className="font-medium">{m.install_guide_android()}</h4>
    <p className="ui-help text-muted-foreground">{m.settings_share_android()}</p>
    {state?.coarsePointer && state.canPrompt && !state.standalone && !state.installed && <Button type="button" variant="outline" className="h-auto min-h-11 whitespace-normal" onClick={() => { void promptInstall().catch(() => setFailed(true)); }}>{m.install_guide_add()}</Button>}
    {failed && <p role="status" className="ui-help">{m.install_guide_retry()}</p>}
    <p className="ui-help text-muted-foreground">{m.install_guide_desktop()}</p>
  </section>;
}
