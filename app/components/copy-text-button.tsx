import { useState } from "react";
import { Button } from "~/components/ui/button";
import { m } from "~/paraglide/messages.js";

// Copies a text to the clipboard and says so (or says it could not).
export function CopyTextButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return <>
    <Button type="button" variant="outline" onClick={() => void copy()}>{label}</Button>
    {state !== "idle" && <span role="status" className="ui-meta text-muted-foreground">{state === "copied" ? copiedLabel : m.invites_copy_failed()}</span>}
  </>;
}
