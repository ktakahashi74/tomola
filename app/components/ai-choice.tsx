import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import type { AiChoice } from "~/lib/open-in-ai";
import { m } from "~/paraglide/messages.js";

export function choiceName(choice: AiChoice): string {
  return choice.provider === "chatgpt" ? m.open_in_ai_chatgpt() : choice.provider === "claude" ? m.open_in_ai_claude() : m.open_in_ai_custom();
}

// Fetch the choice controls only when a dialog or the settings section uses them.
const ChoiceForm = lazy(() => import("./ai-choice-form"));
class ChoiceFormBoundary extends Component<{ children: ReactNode; onCancel?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <><p role="alert">{m.error_unexpected()}</p>{this.props.onCancel && <Button type="button" variant="outline" onClick={this.props.onCancel}>{m.cancel()}</Button>}</> : this.props.children;
  }
}
export function AiChoiceForm(props: ComponentProps<typeof ChoiceForm>) {
  return <ChoiceFormBoundary onCancel={props.onCancel}><Suspense fallback={null}><ChoiceForm {...props} /></Suspense></ChoiceFormBoundary>;
}
