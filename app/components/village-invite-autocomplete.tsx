import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import Suggestions, { type MentionSuggestion } from "./mention-suggestions";

const DELAY_MS = 150;

// Enhance the existing input in place so loading the helper cannot lose text or focus.
export default function VillageInviteAutocomplete({ input, slug }: { input: RefObject<HTMLInputElement | null>; slug: string }) {
  const listId = `${useId()}-invitees`;
  const [items, setItems] = useState<MentionSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const choose = useRef<(handle: string) => void>(() => {});

  useEffect(() => {
    const field = input.current;
    if (!field) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let composing = false;
    let results: MentionSuggestion[] = [];
    let selected = 0;
    const close = () => {
      clearTimeout(timer);
      request?.abort();
      request = undefined;
      results = [];
      selected = 0;
      setItems([]);
      setActive(0);
      setAnnouncement("");
    };
    const chooseHandle = (handle: string) => {
      const item = results.find(item => item.handle === handle);
      if (!item) return;
      field.value = handle;
      close();
      field.dispatchEvent(new Event("input", { bubbles: true }));
      // The input event cancels old results; choosing does not start another search.
      close();
      setAnnouncement(m.village_invite_suggest_selected({ handle }));
      field.focus();
    };
    choose.current = chooseHandle;
    const schedule = () => {
      const query = field.value;
      const length = [...query].length;
      if (composing || length < 1 || length > 30 || document.activeElement !== field) return;
      timer = setTimeout(() => {
        const controller = new AbortController();
        request = controller;
        void (async () => {
          try {
            const response = await fetch(`/villages/${encodeURIComponent(slug)}/invite-suggest?${new URLSearchParams({ q: query, lang: getLocale() })}`, {
              credentials: "same-origin", signal: controller.signal, headers: { accept: "application/json" },
            });
            if (!response.ok) return;
            const body = await response.json() as { members: Array<{ handle: string; name: string | null }> };
            if (controller.signal.aborted || request !== controller || field.value !== query) return;
            results = body.members.map(({ handle, name }) => ({ handle, label: name }));
            selected = 0;
            setItems(results);
            setActive(0);
            setAnnouncement(results.length > 0 ? m.village_invite_suggest_status({ count: results.length }) : "");
          } catch {
            // Offline, aborted or malformed responses leave manual entry available.
          }
        })();
      }, DELAY_MS);
    };
    const update = () => { close(); schedule(); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || composing) return;
      if (event.key === "Escape") { close(); event.preventDefault(); return; }
      if (!results.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
        setActive(selected);
      } else if (event.key === "Enter") {
        event.preventDefault();
        chooseHandle(results[selected].handle);
      }
    };
    const compositionStart = () => { composing = true; close(); };
    const compositionEnd = () => { composing = false; update(); };
    field.setAttribute("role", "combobox");
    field.setAttribute("aria-autocomplete", "list");
    field.setAttribute("aria-haspopup", "listbox");
    field.addEventListener("input", update);
    field.addEventListener("focus", update);
    field.addEventListener("blur", close);
    field.addEventListener("keydown", keyDown);
    field.addEventListener("compositionstart", compositionStart);
    field.addEventListener("compositionend", compositionEnd);
    field.form?.addEventListener("reset", close);
    schedule();
    return () => {
      clearTimeout(timer);
      request?.abort();
      field.removeEventListener("input", update);
      field.removeEventListener("focus", update);
      field.removeEventListener("blur", close);
      field.removeEventListener("keydown", keyDown);
      field.removeEventListener("compositionstart", compositionStart);
      field.removeEventListener("compositionend", compositionEnd);
      field.form?.removeEventListener("reset", close);
      for (const attribute of ["role", "aria-autocomplete", "aria-haspopup", "aria-expanded", "aria-controls", "aria-activedescendant"]) field.removeAttribute(attribute);
    };
  }, [input, slug]);

  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.setAttribute("aria-expanded", String(items.length > 0));
    if (items.length) {
      field.setAttribute("aria-controls", listId);
      field.setAttribute("aria-activedescendant", `${listId}-${active}`);
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
    } else {
      field.removeAttribute("aria-controls");
      field.removeAttribute("aria-activedescendant");
    }
  }, [active, input, items, listId]);

  return <>
    {items.length > 0 && <Suggestions id={listId} items={items} active={active} choose={handle => choose.current(handle)} label={m.village_invite_suggest_label()} />}
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
  </>;
}
