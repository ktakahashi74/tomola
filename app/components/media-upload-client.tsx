import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { MEDIA_LIMITS, type MediaErrorCode } from "~/lib/media";
import { mediaEditor } from "~/lib/media-editor-client";
import { m } from "~/paraglide/messages.js";

function failureMessage(code: MediaErrorCode): string {
  switch (code) {
    case "too_large": return m.media_error_too_large();
    case "type": return m.media_error_type();
    case "rate": return m.media_error_rate();
    case "quota": return m.media_error_quota();
    case "member_bytes": return m.media_error_member_bytes();
    case "site_bytes": return m.media_error_site_bytes();
    default: return m.media_error_generic();
  }
}

// A growing textarea can be taller than the screen. Reveal its selected text,
// rather than scrolling the beginning of the entire field into view on focus.
function revealSelection(field: HTMLTextAreaElement) {
  const style = getComputedStyle(field), frame = field.getBoundingClientRect();
  const mirror = document.createElement("div");
  for (const key of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "padding", "border", "boxSizing", "tabSize", "textIndent", "wordSpacing"] as const) mirror.style[key] = style[key];
  Object.assign(mirror.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", whiteSpace: "pre-wrap", overflowWrap: "anywhere", width: `${frame.width}px`, left: `${frame.left}px`, top: `${frame.top - field.scrollTop}px` });
  mirror.textContent = field.value.slice(0, field.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = field.value.slice(field.selectionStart, field.selectionEnd) || "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const rect = marker.getBoundingClientRect();
  mirror.remove();
  const top = window.visualViewport?.offsetTop ?? 0, bottom = top + (window.visualViewport?.height ?? window.innerHeight);
  if (rect.bottom > bottom - 12) window.scrollBy(0, rect.bottom - bottom + 12);
  else if (rect.top < top + 12) window.scrollBy(0, rect.top - top - 12);
}

export default function MediaUpload({ compact = false }: { compact?: boolean }) {
  const root = useRef<HTMLDivElement>(null), picker = useRef<HTMLInputElement>(null);
  const [toolbar, setToolbar] = useState<Element | null>(null);
  const pending = useRef(false), current = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<MediaErrorCode | null>(null);
  const body = () => root.current?.closest("form")?.querySelector<HTMLTextAreaElement>('textarea[name="body"]') ?? null;
  const upload = async (files: File[]) => {
    if (pending.current) return;
    if (files.length !== 1) { setError("generic"); return; }
    const file = files[0];
    if (file.size > MEDIA_LIMITS.inputBytes) { setError("too_large"); return; }
    pending.current = true; setBusy(true); setError(null);
    const controller = new AbortController(); current.current = controller;
    try {
      const form = new FormData(); form.set("image", file);
      const response = await fetch("/media", { method: "POST", body: form, credentials: "same-origin", signal: controller.signal });
      const result = await response.json() as { url?: string; error?: MediaErrorCode };
      if (!response.ok || !result.url) { setError(result.error ?? "generic"); return; }
      const field = body();
      if (!field) return;
      const editor = mediaEditor(field);
      if (editor) { editor.insert(result.url, ""); return; }
      const alt = m.media_alt_placeholder(), text = `![${alt}](${result.url})`;
      const start = document.activeElement === field ? field.selectionEnd : field.value.length;
      field.setRangeText(text, start, start, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus({ preventScroll: true }); field.setSelectionRange(start + 2, start + 2 + alt.length);
      revealSelection(field);
    } catch { if (!controller.signal.aborted) setError("generic"); }
    finally { pending.current = false; setBusy(false); }
  };
  useEffect(() => {
    const field = body();
    if (!field) return;
    const form = field.form!;
    const accepts = (event: Event) => event.target === field || mediaEditor(field)?.element.contains(event.target as Node);
    const transfer = (event: ClipboardEvent | DragEvent) => {
      if (!accepts(event)) return;
      if ("clipboardData" in event && event.clipboardData?.types.some(type => type === "text/plain" || type === "text/html")) return;
      const files = Array.from(("clipboardData" in event ? event.clipboardData : event.dataTransfer)?.files ?? []);
      if (!files.length || !files.every(file => file.type.startsWith("image/"))) return;
      event.preventDefault(); event.stopPropagation(); void upload(files);
    };
    const over = (event: DragEvent) => { if (accepts(event) && event.dataTransfer?.types.includes("Files")) event.preventDefault(); };
    form.addEventListener("paste", transfer, true); form.addEventListener("drop", transfer, true); form.addEventListener("dragover", over, true);
    return () => { form.removeEventListener("paste", transfer, true); form.removeEventListener("drop", transfer, true); form.removeEventListener("dragover", over, true); current.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!compact) return;
    const editor = body()?.closest("[data-rich-editor-active]");
    if (!editor) return;
    const locate = () => setToolbar(editor.getAttribute("data-rich-editor-active") === "true" ? editor.querySelector("[data-editor-media-slot]") : null);
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(editor, { childList: true, attributes: true, attributeFilter: ["data-rich-editor-active"] });
    return () => observer.disconnect();
  }, [compact]);
  const insert = <Button type="button" variant="outline" size={toolbar ? "icon" : "default"} aria-label={m.media_insert()} title={toolbar ? m.media_insert() : undefined} className="aria-disabled:opacity-50" aria-disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => {
    if (pending.current) return;
    const field = body();
    if (field) (mediaEditor(field)?.element ?? field).focus({ preventScroll: true });
    picker.current?.click();
  }}>{toolbar ? <ImagePlus aria-hidden="true" /> : m.media_insert()}</Button>;
  return <div ref={root} data-media-insert="" className="space-y-2">
    <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) void upload(files); }} />
    {toolbar ? createPortal(insert, toolbar) : insert}
    <p role="status" className="empty:sr-only">{busy ? m.media_uploading() : null}</p>
    {error && <p role="alert" className="text-destructive">{failureMessage(error)}</p>}
  </div>;
}
