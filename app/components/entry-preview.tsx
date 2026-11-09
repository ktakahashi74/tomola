import { Button } from "~/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { m } from "~/paraglide/messages.js";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; html: string; lang: string }
  | { status: "error"; message: string };

// Preview: POST the form body to /preview (members only) and show the server-rendered HTML.
// Rendering uses the same server-side renderMarkdown as posts; no Markdown processor is shipped to the client.
// fixedLang: the post language for forms without a language field, such as editing screens.
// pasteFrontmatter: forms that read and remove initial frontmatter on submission (the value identifies the form kind; new topics and replies). Do not show that frontmatter in the preview either
// (other forms save the body unchanged, so an initial --- is rendered unchanged too).
export function EntryPreview({ kind = "topic", fixedLang, pasteFrontmatter, invalidateOnEdit = false, selectedLang }: { kind?: "topic" | "reply"; fixedLang?: string; pasteFrontmatter?: "topic" | "reply"; invalidateOnEdit?: boolean; selectedLang?: string }) {
  const [state, setState] = useState<State>({ status: "idle" });
  // Prevent an earlier response from replacing a later one after repeated clicks.
  const latest = useRef(0);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!invalidateOnEdit) return;
    // The scoped language select is controlled and does not emit native input/change events.
    latest.current++;
    setState({ status: "idle" });
    const form = element.current?.closest("form");
    const invalidate = (event: Event) => {
      const field = event.target;
      if ((field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && ["body", "lang"].includes(field.name)) {
        latest.current++;
        setState({ status: "idle" });
      }
    };
    form?.addEventListener("input", invalidate);
    form?.addEventListener("change", invalidate);
    return () => { form?.removeEventListener("input", invalidate); form?.removeEventListener("change", invalidate); };
  }, [invalidateOnEdit, selectedLang]);

  async function show(button: HTMLButtonElement) {
    const form = button.form;
    const textarea = form?.elements.namedItem("body");
    if (!form || !(textarea instanceof HTMLTextAreaElement)) return;
    const langField = form.elements.namedItem("lang");
    const lang = fixedLang ?? (langField instanceof HTMLInputElement ? langField.value : "");
    const id = ++latest.current;
    setState({ status: "loading" });
    const fail = (message: string) => id === latest.current && setState({ status: "error", message });
    try {
      const body = new FormData();
      body.set("body", textarea.value);
      // Use the body's language for fixed footnote labels, as in post rendering.
      if (lang) body.set("lang", lang);
      if (pasteFrontmatter) body.set("frontmatter", pasteFrontmatter);
      // redirect: "manual": an expired session redirects to login; do not display that page's HTML as a preview.
      const res = await fetch("/preview", { method: "POST", body, credentials: "same-origin", redirect: "manual" });
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.startsWith("text/html")) {
        const html = await res.text();
        if (id === latest.current) setState({ status: "ready", html, lang: res.headers.get("Content-Language") || lang });
        return;
      }
      const error = type.includes("application/json") ? ((await res.json()) as { error?: string }).error : undefined;
      if (error === "body_too_long") fail(m.error_body_too_long());
      else if (error === "body_too_complex") fail(m.error_body_too_complex());
      else if (error === "body_unrenderable") fail(m.error_body_unrenderable());
      else if (error === "frontmatter_invalid") fail(m.error_frontmatter());
      else if (error === "frontmatter_type_mismatch") fail(m.error_frontmatter_type());
      else if (error === "rate_limited") fail(m.error_rate_limited());
      else fail(m.preview_failed());
    } catch {
      fail(m.preview_failed());
    }
  }

  return (
    <div ref={element} className="space-y-2">
      <Button variant="outline" type="button" onClick={(e) => void show(e.currentTarget)}>
        {m.preview()}
      </Button>
      <div aria-live="polite" className="empty:sr-only">
        {state.status === "loading" && <p className="ui-help text-muted-foreground">{m.preview_loading()}</p>}
        {state.status === "error" && <p className="text-destructive">{state.message}</p>}
      </div>
      {state.status === "ready" && (
        <div dir="auto" lang={state.lang || undefined} className={`longread ${kind === "reply" ? "longread-compact " : ""}rounded border p-3`} dangerouslySetInnerHTML={{ __html: state.html }} />
      )}
    </div>
  );
}
