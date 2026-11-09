import { Component, lazy, Suspense, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { afterInitialActivation } from "~/lib/initial-activation";
import { m } from "~/paraglide/messages.js";

const Tools = lazy(() => import("./ai-editor-tools-content"));
// The props of AiWrite, except the pasted text, which this keeps unless the screen holds it itself (the draft screen keeps it across choosing the latest version).
export type AiEditorToolsProps = Omit<ComponentProps<typeof import("~/components/ai-write").AiWrite>, "candidate" | "onCandidateChange"> & { candidate?: string; onCandidateChange?: (text: string) => void };

class ToolsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="status" className="ui-help text-muted-foreground">{m.ai_tools_unavailable()}</p> : this.props.children; }
}

// Load writing tools independently of the thread's reading code and error boundary (and out of the first script of the writing screens).
export function AiEditorTools(props: AiEditorToolsProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => afterInitialActivation(() => setMounted(true)), []);
  return mounted ? <ToolsBoundary><Suspense fallback={null}><Tools {...props} /></Suspense></ToolsBoundary> : null;
}
