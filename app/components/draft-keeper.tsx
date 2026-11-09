import { lazy, Suspense, useContext, useEffect, useRef } from "react";
import { QuietBoundary, usePageReady } from "~/components/quiet-boundary";
import { FormLanguageChangeContext } from "~/components/form-contexts";
import type { DraftKeeperProps } from "~/components/draft-keeper-content";

const Content = lazy(() => import("./draft-keeper-content"));

function RecoveryUnavailable() {
  const holder = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = holder.current?.closest("form");
    if (!form) return;
    form.dataset.draftRecovery = "ready";
    form.dispatchEvent(new Event("tomola:draft-recovery-ready"));
  }, []);
  return <span ref={holder} hidden />;
}

// Put inside a writing form: keeps what is typed on this device (see draft-keeper-content.tsx). The part that does it is loaded after the page is ready, so that it is not part
// of the page's first script.
export function DraftKeeper(props: DraftKeeperProps) {
  const language = useContext(FormLanguageChangeContext);
  return usePageReady() ? <QuietBoundary fallback={<RecoveryUnavailable />}><Suspense fallback={null}><Content key={props.owner} {...props} onLanguageChange={lang => language?.current?.(lang)} /></Suspense></QuietBoundary> : null;
}
