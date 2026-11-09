import type { ComponentProps } from "react";
import { Input } from "~/components/ui/input";

// Normalize the actual input value, retaining the caret when editing a name.
export function HandleInput(props: ComponentProps<typeof Input>) {
  return <Input {...props} autoCapitalize="none" autoCorrect="off" spellCheck={false} onInput={event => {
    const input = event.currentTarget;
    const lower = input.value.toLowerCase();
    if (lower === input.value) return;
    const { selectionStart, selectionEnd } = input;
    input.value = lower;
    input.setSelectionRange(selectionStart, selectionEnd);
  }} />;
}
