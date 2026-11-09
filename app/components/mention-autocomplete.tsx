import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { mentionQueryAt } from "~/lib/mention-syntax";
import { m } from "~/paraglide/messages.js";
import type { MentionSuggestion } from "./mention-suggestions";

// The body textarea of the posting forms, with handle suggestions for @mentions. Without JavaScript it is a plain textarea: a handle typed by hand works the same.
// When the text before the cursor ends with a mention that is being typed (an @ or ＠ and 1 to 30 handle characters, mentionQueryAt), the handles that start like it are asked of
// GET /mentions/suggest after 150 ms and shown in a list under the field: the up and down arrow keys choose, Enter or Tab puts "@handle " in place of what was typed, Escape closes it,
// and a click chooses too. The list is a listbox; the textarea keeps its own role (aria-autocomplete="list", aria-controls and aria-activedescendant point at the list: aria-expanded is not
// allowed on a textarea, so the number of suggestions is told through a polite live region instead).
const loadSuggestions = () => import("./mention-suggestions");
const Suggestions = lazy(loadSuggestions);

const DELAY_MS = 150;

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "aria-autocomplete" | "aria-controls" | "aria-activedescendant"> & { village?: string };

export function MentionTextarea(props: Props) {
  const { onInput, onKeyDown, onBlur, onClick, onKeyUp, village, ...rest } = props;
  const id = useId();
  const listId = `${id}-mentions`;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [items, setItems] = useState<MentionSuggestion[]>([]);
  const [active, setActive] = useState(0);
  // Where the mention that is being typed starts (the index of its sigil) and what is typed after it.
  const typing = useRef<{ start: number; query: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const open = items.length > 0;

  const close = () => {
    clearTimeout(timer.current);
    request.current?.abort();
    request.current = undefined;
    typing.current = null;
    setItems([]);
    setActive(0);
  };
  useEffect(() => () => {
    clearTimeout(timer.current);
    request.current?.abort();
  }, []);
  useEffect(() => {
    if (!village) return;
    const form = ref.current?.form;
    form?.addEventListener("reset", close);
    return () => form?.removeEventListener("reset", close);
  }, [village]);

  // Look at the text before the cursor: the mention being typed, if any, is asked for after the delay.
  const update = () => {
    const el = ref.current;
    if (!el) return;
    const found = el.selectionStart === el.selectionEnd ? mentionQueryAt(el.value.slice(0, el.selectionStart)) : null;
    if (!found) {
      close();
      return;
    }
    if (typing.current?.query === found.query && typing.current.start === found.start) return;
    request.current?.abort();
    request.current = undefined;
    setItems([]);
    setActive(0);
    typing.current = found;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void fetchHandles(found), DELAY_MS);
  };

  async function fetchHandles(found: { start: number; query: string }) {
    if (typing.current?.query !== found.query || typing.current.start !== found.start) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller && typing.current?.query === found.query && typing.current.start === found.start;
    try {
      const { fetchSuggestions } = await loadSuggestions();
      if (!current()) return;
      const suggestions = await fetchSuggestions(found.query, village, controller.signal);
      // An answer for what was typed before is not shown for what is typed now.
      if (!current()) return;
      setItems(suggestions);
      setActive(0);
    } catch {
      // Aborted, offline, or not JSON: no suggestions.
    }
  }

  function choose(handle: string) {
    const el = ref.current;
    const found = typing.current;
    if (!el || !found) return;
    el.setRangeText(`@${handle} `, found.start, el.selectionStart, "end");
    // The textarea is not controlled: tell whoever listens (the preview reads the value when it is pressed; a form library would listen to input).
    el.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    el.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (village === undefined) onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (!open) { if (village !== undefined) onKeyDown?.(event); return; }
    // A key that confirms text of an input method (Japanese, Chinese, Korean) is not ours.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choose(items[active].handle);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if (village !== undefined && !event.defaultPrevented) onKeyDown?.(event);
  }

  return (
    <div className="relative">
      <textarea
        {...rest}
        ref={ref}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onInput={(event) => {
          onInput?.(event);
          update();
        }}
        onKeyUp={(event) => {
          onKeyUp?.(event);
          // The arrow keys move the cursor (not the choice) when the list is not open; the text before the cursor decides again.
          if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key) || !open) update();
        }}
        onClick={(event) => {
          onClick?.(event);
          update();
        }}
        onBlur={(event) => {
          onBlur?.(event);
          // A click on a suggestion is handled before the field loses focus (onMouseDown below): closing here is safe.
          close();
        }}
        onKeyDown={handleKeyDown}
      />
      {open && <Suspense fallback={null}><Suggestions id={listId} items={items} active={active} choose={choose} /></Suspense>}
      <p className="sr-only" role="status" aria-live="polite">
        {open ? m.mention_suggestions_status({ count: items.length }) : ""}
      </p>
    </div>
  );
}
