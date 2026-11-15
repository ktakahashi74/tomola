import { useState } from "react";
import { Button } from "~/components/ui/button";
import { m } from "~/paraglide/messages.js";

// Copies text and optionally lets the caller update its button label.
export function CopyTextButton({ text, label, copiedLabel, failedLabel = m.invites_copy_failed(), showCopied = true, onResult }: { text: string; label: string; copiedLabel: string; failedLabel?: string; showCopied?: boolean; onResult?: (copied: boolean) => void }) {
  const [copied, setCopied] = useState<boolean>();
  async function copy() {
    let result = false;
    try {
      await navigator.clipboard.writeText(text);
      result = true;
    } catch { /* Keep failure feedback when the clipboard is unavailable or denied. */ }
    setCopied(result);
    onResult?.(result);
  }
  return <>
    <Button type="button" variant="outline" onClick={copy}>{label}</Button>
    {copied !== undefined && <span role="status" className="ui-meta text-muted-foreground">{copied ? showCopied ? copiedLabel : "" : failedLabel}</span>}
  </>;
}
