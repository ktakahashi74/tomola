import { Component, useEffect, useState, type ReactNode } from "react";
import { afterInitialActivation } from "~/lib/initial-activation";

// For the helpers of a writing form that are loaded after the page is ready (the local copy of what is typed, the count under the field, the "…" under the reply field):
// they are a help and not a need, so if one cannot be loaded it is left out and the form works as it did.
export class QuietBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? (this.props.fallback ?? null) : this.props.children; }
}

// True once the page is ready (hydrated, and no press of the member's is still in progress).
export function usePageReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => afterInitialActivation(() => setReady(true)), []);
  return ready;
}
