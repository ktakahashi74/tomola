import type { RefObject } from "react";
import { AiChoiceForm } from "~/components/ai-choice";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from "~/components/ui/dropdown-menu";
import { serializeChoice, type AiChoice } from "~/lib/open-in-ai";
import { m } from "~/paraglide/messages.js";

export function MenuItems({ mdUrl, mdPath, onCopy, onNotice, showDialog }: {
  mdUrl: string; mdPath: string; onCopy: () => void; onNotice: (notice: string | null) => void; showDialog: () => void;
}) {
  async function copy(text: string | Promise<string>) {
    onCopy();
    onNotice(null);
    try {
      // Pass the text Promise directly to keep the clipboard write in the click gesture.
      if (typeof text !== "string" && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then(t => new Blob([t], { type: "text/plain" })) })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      onNotice(m.open_in_ai_copied());
    } catch {
      onNotice(m.open_in_ai_copy_failed());
    }
  }
  async function fetchMarkdown() {
    const res = await fetch(mdPath, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.text();
  }

  return <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-2rem)]">
    <DropdownMenuGroup>
      <DropdownMenuLabel className="px-2 py-2 ui-help font-normal text-muted-foreground">{m.open_in_ai_help()}</DropdownMenuLabel>
      <DropdownMenuItem onClick={() => void copy(mdUrl)}>{m.open_in_ai_copy_url()}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => void copy(fetchMarkdown())}>{m.open_in_ai_copy_md()}</DropdownMenuItem>
      <DropdownMenuItem onClick={showDialog}>{m.open_in_ai_change()}</DropdownMenuItem>
      <DropdownMenuItem render={<a href="/connect">{m.connect_keep_using_link()}</a>} />
    </DropdownMenuGroup>
  </DropdownMenuContent>;
}

export function ChoiceDialog({ trigger, initial, reader, open, onOpenChange, onChoice }: {
  trigger: RefObject<HTMLButtonElement | null>; initial: AiChoice | null; reader: boolean;
  open: boolean; onOpenChange: (open: boolean) => void; onChoice: (choice: AiChoice) => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent finalFocus={trigger} showCloseButton={false} className="sm:max-w-lg">
      <DialogTitle className="text-lg font-semibold">{m.open_in_ai_dialog_title()}</DialogTitle>
      <DialogDescription>{reader ? m.open_in_ai_dialog_help_guest() : m.open_in_ai_dialog_help()}</DialogDescription>
      <AiChoiceForm
        key={initial ? serializeChoice(initial) : "none"}
        initial={initial}
        submitLabel={m.open_in_ai_save_open()}
        onCancel={() => onOpenChange(false)}
        onSubmit={onChoice}
      />
      <p className="ui-meta"><a href="/connect" className="underline">{m.connect_keep_using_link()}</a></p>
    </DialogContent>
  </Dialog>;
}
