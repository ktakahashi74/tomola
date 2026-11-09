import { useEffect, useState } from "react";
import { isIosDevice, standaloneDisplay } from "~/lib/install-guide";
import { m } from "~/paraglide/messages.js";

export function IosStandaloneLoginNote() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const display = window.matchMedia("(display-mode: standalone)");
    const update = () => setVisible(isIosDevice(navigator) && standaloneDisplay());
    update();
    display.addEventListener("change", update);
    return () => display.removeEventListener("change", update);
  }, []);
  return visible ? <p data-ios-login-note className="rounded-lg bg-muted p-3">{m.login_ios_standalone()}</p> : null;
}
