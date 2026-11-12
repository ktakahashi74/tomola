import { Component, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { afterInitialActivation } from "~/lib/initial-activation";
import {
  AI_CHOICE_STORAGE_KEY,
  buildOpenUrl,
  parseChoice,
  serializeChoice,
  type AiChoice,
} from "~/lib/open-in-ai";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { m } from "~/paraglide/messages.js";
import { useAiOpenReturn } from "~/components/use-ai-open-return";
import type { Lang, SourceLang } from "~/lib/languages";
import { languageLabel } from "~/lib/language-label";

// "AIで開く": open the chosen AI (ChatGPT, Claude or a user-provided URL template) with a prompt containing the page's Markdown-twin URL
// with a click-issued key for members, or an inert receipt marker for public readers. Store only the AI choice in localStorage.
// Show nothing without JavaScript: the button is rendered on the client.

export function readChoice(): AiChoice | null {
  try {
    return parseChoice(window.localStorage.getItem(AI_CHOICE_STORAGE_KEY));
  } catch {
    // localStorage is unavailable, for example in private browsing; the choice is not persisted.
    return null;
  }
}

export function saveChoice(choice: AiChoice | null) {
  try {
    if (choice) window.localStorage.setItem(AI_CHOICE_STORAGE_KEY, serializeChoice(choice));
    else window.localStorage.removeItem(AI_CHOICE_STORAGE_KEY);
    return true;
  } catch {
    // Opening still works for this attempt even if persistence fails.
    return false;
  }
}

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

// mdUrl: this page's token-free absolute Markdown-twin URL. mdPath: the same page's path without a token
// ("Markdownでコピー" fetches it using the session cookie).
export function OpenInAi({ mdUrl, mdPath, reader = false, showNoScript = true, sourceLang, readingLang }: { mdUrl: string; mdPath: string; reader?: boolean; showNoScript?: boolean; sourceLang?: SourceLang; readingLang?: SourceLang }) {
  const [mounted, setMounted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Dialog initial values: reread the saved localStorage choice each time the dialog opens, rather than on every render.
  const [initial, setInitial] = useState<AiChoice | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const reading = useAiOpenReturn(mdUrl);
  useEffect(() => afterInitialActivation(() => setMounted(true)), []);
  // Show no button while JavaScript is unavailable (server rendering and before hydration). For browsing without JavaScript, <noscript> supplies
  // an ordinary Markdown-twin link without a token, readable with the browser session.
  if (!mounted) {
    if (!showNoScript) return null;
    return (
      <noscript>
        <a href={mdPath} className="text-sm underline">
          {m.open_in_ai_noscript()}
        </a>
      </noscript>
    );
  }

  async function open(choice: AiChoice) {
    // Reserve the tab synchronously during the user's gesture. Detach its opener
    // before fetching; creating a tab only after await is blocked by browsers.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    const clickedAt = Date.now();
    setNotice(null);
    const attemptId = reading.reset();
    try {
      if (!popup) throw new Error("Popup blocked");
      const body = new FormData();
      body.set("path", mdPath);
      let link: string;
      try {
        const response = await fetch("/open-in-ai/link", { method: "POST", body, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
        if (!response.ok) throw new Error("Link unavailable");
        const result = await response.json() as { url?: unknown };
        if (typeof result.url !== "string") throw new Error("Invalid link response");
        link = result.url;
      } catch (error) {
        if (!reader) throw error;
        popup.location.replace(buildOpenUrl(choice, prompt(mdUrl)));
        return;
      }
      popup.location.replace(buildOpenUrl(choice, prompt(link)));
      reading.start(link, clickedAt, attemptId);
    } catch {
      popup?.close();
      setNotice(m.error_unexpected());
    }
  }

  function prompt(url: string) {
    return sourceLang && readingLang && sourceLang !== readingLang
      ? m.open_in_ai_prompt_translated({ source: languageLabel(sourceLang), reading: languageLabel(readingLang), url })
      : m.open_in_ai_prompt({ url });
  }

  function showDialog() {
    reading.reset();
    setInitial(readChoice());
    setDialogOpen(true);
  }

  function click() {
    reading.reset();
    const choice = readChoice();
    if (choice) void open(choice);
    else showDialog();
  }

  async function copy(text: string | Promise<string>) {
    reading.reset();
    setNotice(null);
    try {
      // Pass the text Promise directly when possible so the operation remains a click gesture while fetching.
      if (typeof text !== "string" && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      setNotice(m.open_in_ai_copied());
    } catch {
      setNotice(m.open_in_ai_copy_failed());
    }
  }

  const fetchMarkdown = async () => {
    const res = await fetch(mdPath, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.text();
  };

  return (
    <div className="relative inline-flex max-w-full flex-wrap items-center gap-1 text-sm">
      <Button ref={trigger} type="button" variant="outline" title={m.open_in_ai_help()} onClick={click}>
        {m.open_in_ai()}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger onClick={reading.reset} aria-label={m.open_in_ai_menu()} render={<Button variant="outline" size="icon" />}><ChevronDown aria-hidden="true" /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-2rem)]">
          <DropdownMenuGroup><DropdownMenuLabel className="px-2 py-2 ui-help font-normal text-muted-foreground">{m.open_in_ai_help()}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => void copy(mdUrl)}>{m.open_in_ai_copy_url()}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copy(fetchMarkdown())}>{m.open_in_ai_copy_md()}</DropdownMenuItem>
          <DropdownMenuItem onClick={showDialog}>{m.open_in_ai_change()}</DropdownMenuItem>
          <DropdownMenuItem render={<a href="/connect">{m.connect_keep_using_link()}</a>} /></DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span role="status" className="ui-meta text-muted-foreground empty:sr-only">
        {notice}
      </span>
      <p role="status" className="basis-full ui-meta text-muted-foreground empty:sr-only">{reading.notRead ? m.open_in_ai_not_read({ copy: m.open_in_ai_copy_md() }) : null}</p>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent finalFocus={trigger} showCloseButton={false} className="sm:max-w-lg">
          <DialogTitle className="text-lg font-semibold">
            {m.open_in_ai_dialog_title()}
          </DialogTitle>
          <DialogDescription>{reader ? m.open_in_ai_dialog_help_guest() : m.open_in_ai_dialog_help()}</DialogDescription>
          <AiChoiceForm
            key={initial ? serializeChoice(initial) : "none"}
            initial={initial}
            submitLabel={m.open_in_ai_save_open()}
            onCancel={() => setDialogOpen(false)}
            onSubmit={(choice) => {
              saveChoice(choice);
              setDialogOpen(false);
              void open(choice);
            }}
          />
          <p className="ui-meta"><a href="/connect" className="underline">{m.connect_keep_using_link()}</a></p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// AI selection on the settings page, reading and writing this browser's localStorage.
export function OpenInAiSettings() {
  const [mounted, setMounted] = useState(false);
  const [choice, setChoice] = useState<AiChoice | null>(null);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [formVersion, setFormVersion] = useState(0);
  const status = useRef<HTMLParagraphElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const focus = useRef<"saved" | "heading" | null>(null);
  useLayoutEffect(() => {
    if (focus.current) { (focus.current === "saved" ? status : heading).current?.focus({ preventScroll: true }); focus.current = null; }
  });
  useEffect(() => afterInitialActivation(() => {
    setChoice(readChoice());
    setMounted(true);
  }), []);
  if (!mounted) return null;
  return (
    <section id="settings-ai-choice" aria-labelledby="settings-ai-heading" className="space-y-3">
      <h3 ref={heading} tabIndex={-1} id="settings-ai-heading" className="text-lg font-semibold">{m.settings_ai_heading()}</h3>
      <p className="ui-help text-muted-foreground">{m.settings_ai_help()}</p>
      <p>{choice ? m.settings_ai_current({ name: choiceName(choice) }) : m.settings_ai_none()}</p>
      {/* Keep the control mounted so saving never takes focus from a choice. */}
      <AiChoiceForm
        key={formVersion}
        initial={choice}
        submitLabel={m.open_in_ai_save()}
        autoSave
        onEdit={() => { setSaved(false); setFailed(false); }}
        onSubmit={(next) => {
          if (!saveChoice(next)) { setFailed(true); return false; }
          setChoice(next);
          setSaved(true);
          return true;
        }}
      />
      {failed && <p role="alert" className="ui-meta text-destructive">{m.error_generic()}</p>}
      <p ref={status} tabIndex={-1} role="status" aria-live="polite" className="ui-meta text-muted-foreground empty:sr-only">{saved ? m.settings_ai_saved() : null}</p>
      {choice && (
        <Button
          type="button"
          variant="link"
          onClick={() => {
            setSaved(false);
            if (!saveChoice(null)) { setFailed(true); return; }
            setFailed(false);
            setFormVersion(version => version + 1);
            setChoice(null);
            focus.current = "heading";
          }}
        >
          {m.settings_ai_forget()}
        </Button>
      )}
    </section>
  );
}
