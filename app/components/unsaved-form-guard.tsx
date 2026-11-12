import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useActionData, useBlocker, useNavigation } from "react-router";
import { m } from "~/paraglide/messages.js";
import { UNSAVED_NAVIGATION_EVENT } from "~/lib/http/unsaved-navigation";
import { draftIsDirty, flushDraft } from "~/lib/draft-autosave";

const names = ["title", "body", "note", "lang", "asksStance", "intro", "stanceTag", "village"] as const;
type Values = Record<typeof names[number], string>;
export type UnsavedInitialValues = Partial<Record<typeof names[number], string | boolean | null>>;
function normalize(name: typeof names[number], value: string): string {
  const text = value.replace(/\r\n?/g, "\n");
  return name === "title" || name === "body" ? text.trim() : text;
}
function initialValues(input: UnsavedInitialValues = {}): Values {
  return Object.fromEntries(names.map(name => [name, normalize(name, input[name] === true ? "1" : input[name] === false ? "" : input[name] ?? "")])) as Values;
}
function readValues(form: HTMLFormElement, fallback: Values, submitted?: FormData): Values {
  const data = submitted ?? new FormData(form);
  const present = new Set(Array.from(form.elements).flatMap(element =>
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && !element.matches(":disabled") ? [element.name] : []));
  return Object.fromEntries(names.map(name => [name, data.has(name) || present.has(name) ? normalize(name, String(data.get(name) ?? "")) : fallback[name]])) as Values;
}

// Compare with saved content, not DOM defaults: client-only selects mount after hydration.
export function UnsavedFormGuard({ form, mode, bypass, initial, retainOnSamePath = false }: {
  form: RefObject<HTMLFormElement | null>; mode: "new" | "edit"; bypass: RefObject<boolean>; initial?: UnsavedInitialValues; retainOnSamePath?: boolean;
}) {
  const basis = useRef(initialValues(initial));
  const baseline = useRef(JSON.stringify(basis.current));
  const submitted = useRef<Values | null>(null);
  const savedSnapshot = useRef<string | null>(null);
  const navigation = useNavigation();
  const result = useActionData<{ saved?: boolean; error?: string | null }>();
  const dirty = useCallback(() => {
    if (!form.current) return false;
    const managed = draftIsDirty(form.current);
    if (managed !== undefined) return managed;
    const values = readValues(form.current, basis.current);
    const snapshot = JSON.stringify(values);
    if (savedSnapshot.current === snapshot) return false;
    if (mode === "new") return (["title", "body", "note"] as const).some(name => values[name] !== basis.current[name]);
    return snapshot !== baseline.current;
  }, [form, mode]);
  const check = useCallback((event: BeforeUnloadEvent) => {
    if (form.current) void flushDraft(form.current, true);
    if (!bypass.current && dirty()) { event.preventDefault(); event.returnValue = ""; }
  }, [bypass, dirty, form]);
  const approveDeparture = useCallback((discardLocal = true) => {
    // The member chose to leave and discard what was typed: the copy kept on this device goes too (see DraftKeeper).
    if (discardLocal) form.current?.dispatchEvent(new Event("tomola:form-discarded"));
    bypass.current = true;
    window.removeEventListener("beforeunload", check);
  }, [bypass, check, form]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (bypass.current) { bypass.current = false; return false; }
    // Topic replies survive query changes as well as scrolling within the editor.
    if (currentLocation.pathname === nextLocation.pathname && (retainOnSamePath || currentLocation.search === nextLocation.search)) return false;
    return dirty();
  });
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let active = true;
    void (async () => {
      if (form.current) await flushDraft(form.current, true);
      if (!active) return;
      if (!dirty()) blocker.proceed();
      else if (window.confirm(m.leave_unsaved_confirm())) {
        // Logout clears device writing only after the server ends the session.
        approveDeparture(blocker.location.pathname !== "/logout");
        blocker.proceed();
      }
      else blocker.reset();
    })();
    return () => { active = false; };
  }, [blocker, approveDeparture, dirty, form]);
  useEffect(() => {
    const discard = () => { bypass.current = true; setTimeout(() => { bypass.current = false; }, 0); };
    const confirmLeave = (event: Event) => {
      if (form.current) void flushDraft(form.current, true);
      if (bypass.current || !dirty()) return;
      if (window.confirm(m.leave_unsaved_confirm())) approveDeparture();
      else event.preventDefault();
    };
    const saved = (event: Event) => {
      if (!form.current) return;
      const fields = event instanceof CustomEvent && event.detail instanceof FormData ? event.detail : undefined;
      basis.current = readValues(form.current, basis.current, fields);
      baseline.current = JSON.stringify(basis.current);
      savedSnapshot.current = baseline.current;
    };
    const element = form.current;
    element?.addEventListener("tomola:form-saved", saved);
    window.addEventListener("beforeunload", check);
    window.addEventListener("tomola:discard-unsaved", discard);
    window.addEventListener(UNSAVED_NAVIGATION_EVENT, confirmLeave);
    return () => {
      element?.removeEventListener("tomola:form-saved", saved);
      window.removeEventListener("beforeunload", check);
      window.removeEventListener("tomola:discard-unsaved", discard);
      window.removeEventListener(UNSAVED_NAVIGATION_EVENT, confirmLeave);
    };
  }, [dirty, form, bypass, check, approveDeparture]);
  useEffect(() => {
    if (navigation.state !== "idle") {
      const element = form.current;
      if (submitted.current === null && element && navigation.formData?.has("body") && navigation.formAction && new URL(navigation.formAction, window.location.href).pathname === new URL(element.action).pathname) {
        submitted.current = readValues(element, basis.current, navigation.formData);
      }
      return;
    }
    if (submitted.current !== null) {
      if (result?.saved) { basis.current = submitted.current; baseline.current = JSON.stringify(basis.current); savedSnapshot.current = baseline.current; }
      submitted.current = null;
      bypass.current = false;
    }
  }, [navigation.state, result, form, bypass]);
  useEffect(() => {
    if (navigation.state === "idle" && blocker.state === "unblocked") {
      bypass.current = false;
      window.addEventListener("beforeunload", check);
    }
  }, [navigation.state, blocker.state, bypass, check]);
  return null;
}
