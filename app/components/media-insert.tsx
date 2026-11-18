import { Component, type ReactNode, lazy, Suspense, useEffect, useState } from "react";
import { m } from "~/paraglide/messages.js";
import { afterInitialActivation } from "~/lib/initial-activation";
const Upload = lazy(() => import("./media-upload-client"));
const Help = lazy(() => import("./media-upload-client").then(module => ({ default: module.MediaUploadHelp })));

class UploadBoundary extends Component<{ children: ReactNode; hideFailure?: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? this.props.hideFailure ? null : <p role="status" className="ui-help text-muted-foreground">{m.media_unavailable()}</p> : this.props.children;
  }
}

function useMediaReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => afterInitialActivation(() => setReady(true)), []);
  return ready;
}

// The editor owns both slots; React owns their placement and lifecycle.
export function MediaInsert({ compact = false }: { compact?: boolean } = {}) {
  const ready = useMediaReady();
  return ready ? <div data-media-slot><UploadBoundary><Suspense fallback={null}><Upload compact={compact} /></Suspense></UploadBoundary></div> : null;
}
export function MediaInsertHelp() {
  const ready = useMediaReady();
  return ready ? <UploadBoundary hideFailure><Suspense fallback={null}><Help /></Suspense></UploadBoundary> : null;
}
