import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { afterInitialActivation, afterPageIdle } from "~/lib/initial-activation";
import {
  buildOpenUrl,
  readChoice,
  saveChoice,
  type AiChoice,
} from "~/lib/open-in-ai";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { QuietBoundary } from "~/components/quiet-boundary";
import { m } from "~/paraglide/messages.js";
import { useAiOpenReturn } from "~/components/use-ai-open-return";
import type { SourceLang } from "~/lib/languages";
import { languageLabel } from "~/lib/language-label";

// "AIで開く": open the chosen AI (ChatGPT, Claude or a user-provided URL template) with a prompt containing the page's Markdown-twin URL
// with a click-issued key for members, or an inert receipt marker for public readers. Store only the AI choice in localStorage.
// Buttons mount after hydration. The native Markdown link is available without JavaScript.
const loadDetails = () => import("./open-in-ai-details");
const MenuItems = lazy(() => loadDetails().then(module => ({ default: module.MenuItems })));
const ChoiceDialog = lazy(() => loadDetails().then(module => ({ default: module.ChoiceDialog })));

// mdUrl: this page's token-free absolute Markdown-twin URL. mdPath: the same page's path without a token
// ("Markdownでコピー" fetches it using the session cookie).
export function OpenInAi({ mdUrl, mdPath, reader = false, showNoScript = true, sourceLang, readingLang }: { mdUrl: string; mdPath: string; reader?: boolean; showNoScript?: boolean; sourceLang?: SourceLang; readingLang?: SourceLang }) {
  const [mounted, setMounted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Dialog initial values: reread the saved localStorage choice each time the dialog opens, rather than on every render.
  const [initial, setInitial] = useState<AiChoice | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [hasOpenedMenu, setHasOpenedMenu] = useState(false);
  const [dialog, setDialog] = useState<"unused" | "open" | "closed">("unused");
  const setDialogOpen = (open: boolean) => setDialog(open ? "open" : "closed");
  const reading = useAiOpenReturn(mdUrl);
  useEffect(() => afterInitialActivation(() => setMounted(true)), []);
  useEffect(() => {
    if (mounted && !reader) return afterPageIdle(() => { void loadDetails().catch(() => {}); });
  }, [mounted, reader]);
  const markdownLink = <a href={mdPath} className="text-sm underline">{m.open_in_ai_noscript()}</a>;
  // Show no button while JavaScript is unavailable (server rendering and before hydration). For browsing without JavaScript, <noscript> supplies
  // an ordinary Markdown-twin link without a token, readable with the browser session.
  if (!mounted) {
    if (!showNoScript) return null;
    return <noscript>{markdownLink}</noscript>;
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

  const controls = (
    <div className="relative inline-flex max-w-full flex-wrap items-center gap-1 text-sm">
      <Button ref={trigger} type="button" variant="outline" title={m.open_in_ai_help()} onClick={click}>
        {m.open_in_ai()}
      </Button>
      {/* Keep the trigger mounted while the popup loads, so the first press and focus stay with it. */}
      <DropdownMenu onOpenChange={open => { if (open) setHasOpenedMenu(true); }}>
        <DropdownMenuTrigger onClick={reading.reset} aria-label={m.open_in_ai_menu()} render={<Button variant="outline" size="icon" />}><ChevronDown aria-hidden="true" /></DropdownMenuTrigger>
        {hasOpenedMenu && <Suspense fallback={null}>
          <MenuItems mdUrl={mdUrl} mdPath={mdPath} onCopy={reading.reset} onNotice={setNotice} showDialog={showDialog} />
        </Suspense>}
      </DropdownMenu>
      <span role="status" className="ui-meta text-muted-foreground empty:sr-only">
        {notice}
      </span>
      <p role="status" className="basis-full ui-meta text-muted-foreground empty:sr-only">{reading.notRead ? m.open_in_ai_not_read({ copy: m.open_in_ai_copy_md() }) : null}</p>
      {dialog !== "unused" && <Suspense fallback={null}>
        <ChoiceDialog trigger={trigger} initial={initial} reader={reader} open={dialog === "open"} onOpenChange={setDialogOpen} onChoice={choice => {
          saveChoice(choice);
          setDialogOpen(false);
          void open(choice);
        }} />
      </Suspense>}
    </div>
  );
  return <QuietBoundary fallback={markdownLink}>{controls}</QuietBoundary>;
}
