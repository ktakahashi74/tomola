import { Component, type ReactNode, lazy, Suspense, useEffect, useState } from "react";
import { FieldDescription } from "~/components/ui/field";
import { m } from "~/paraglide/messages.js";
import { afterInitialActivation } from "~/lib/initial-activation";
const Upload = lazy(() => import("./media-upload-client"));

class UploadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="status" className="ui-help text-muted-foreground">{m.media_unavailable()}</p> : this.props.children;
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
  return ready ? <FieldDescription>{m.media_help()}</FieldDescription> : null;
}
