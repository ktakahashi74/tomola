import { lazy, Suspense, useState } from "react";
import { installGuideMode } from "~/lib/install-guide";
import { useInstallGuide } from "~/lib/use-install-guide";

const Notice = lazy(() => import("./install-guide-notice"));

export function HomeInstallGuide() {
  const state = useInstallGuide();
  const [failed, setFailed] = useState(false);
  const mode = state && installGuideMode({ ...state, canPrompt: state.canPrompt || failed, member: true });
  return mode ? <Suspense fallback={null}><Notice mode={mode} failed={failed} onFailure={() => setFailed(true)} /></Suspense> : null;
}
