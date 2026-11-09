import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigation } from "react-router";
import { afterInitialActivation } from "~/lib/initial-activation";
import { baseOf, draftStoreForOwner, localDraftKey, orBlank, localDraftStore, rememberDraftOwner, removeLocalDraftFamily, type DraftStore, type LocalDraft } from "~/lib/local-draft";
import { keepDraft, removeShownDraft, sameDraft, setAsideDrafts, type SetAsideDraft } from "~/lib/set-aside-drafts";
import { replaceEditorBody } from "~/lib/ai-draft";
import { QuietBoundary } from "~/components/quiet-boundary";
import { m } from "~/paraglide/messages.js";

const SAVE_DELAY_MS = 1000;
const OlderDraftNavigation = lazy(() => import("./older-draft-navigation"));
// The record each screen family (the reply field of one thread) wrote to last, kept outside the part: the part is drawn again, not only changed, when the reply target changes.
const lastKeyOfFamily = new Map<string, string>();

// `family`: the front part of `scope` shared by the records of one screen that keeps one per state (the reply field keeps one per reply target); all of them go when the form is sent or discarded.
export type DraftKeeperProps = { owner: string; scope: string; family?: string; startTitle?: string | null; startBody: string; store?: DraftStore; onRecovery?: (record: LocalDraft | null) => void; onDiscard?: (fields: FormData) => void; onLanguageChange?: (lang: string) => void };

function fieldsOf(form: HTMLFormElement | null | undefined) {
  const title = form?.elements.namedItem("title");
  const body = form?.elements.namedItem("body");
  return { title: title instanceof HTMLInputElement ? title : null, body: body instanceof HTMLTextAreaElement ? body : null };
}

// Put inside a writing form. While the member types, the title and body are kept on this device (not on the server) so that a lost connection, a reload or
// a discarded mobile tab does not lose them; the next visit to the same screen offers them back. The record is removed when the server accepts the form
// (it answers with a redirect), when the member leaves the page and chooses to discard what was typed, and when the member logs out. A refused form (an error shown in place) and a failed request keep it.
// `scope` names the screen (a new topic, the reply form of one thread, the edit of one entry, one draft); `startTitle` and `startBody` are the text the screen
// starts from (not what a refused form shows again), so that a record is offered back only onto the same starting text.
export default function DraftKeeperContent({ owner, scope, family, startTitle, startBody, store = localDraftStore, onRecovery, onDiscard, onLanguageChange }: DraftKeeperProps) {
  const ownedStore = useMemo(() => draftStoreForOwner(owner, store), [owner, store]);
  const { read: readLocalDraft, write: writeLocalDraft, remove: removeLocalDraft } = ownedStore;
  const recovery = useRef(onRecovery);
  recovery.current = onRecovery;
  const startingText = useRef({ title: startTitle, body: startBody });
  useEffect(() => { startingText.current = { title: startTitle, body: startBody }; }, [startTitle, startBody]);
  const decided = useRef<{ key: string; base: string; store: DraftStore } | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const key = localDraftKey(owner, scope);
  const base = baseOf(startTitle, startBody);
  const [restored, setRestored] = useState<{ at: number; original: { title: string; body: string }; fields: FormData } | null>(null);
  const [saved, setSaved] = useState(false);
  // Unsent writing made on an earlier text of this screen (the text it starts from has changed since: an edit made elsewhere, an AI's change to a draft). It is set aside, never dropped.
  const [older, setOlder] = useState<SetAsideDraft[]>([]);
  const [failed, setFailed] = useState(false);
  const refreshOlder = useCallback((shown?: SetAsideDraft) => {
    const records = setAsideDrafts(key, ownedStore);
    // A storage event can add choices, but cannot retarget the displayed buttons.
    setOlder(shown ? [shown, ...records.filter(item => item.key !== shown.key || !sameDraft(item.record, shown.record))] : records);
  }, [key, ownedStore]);
  const keep = useCallback((record: LocalDraft) => {
    const written = keepDraft(key, record, ownedStore);
    const form = holder.current?.closest("form");
    if (form) { if (written) delete form.dataset.draftPreserve; else form.dataset.draftPreserve = "blocked"; }
    setFailed(!written);
    return written;
  }, [key, ownedStore]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fade = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The form was accepted, or the member chose to leave and discard what was typed: nothing more is written.
  const accepted = useRef(false);
  // Set when the part is taken off the page (not when only its record changes, as when the reply target is changed on the same screen).
  const leaving = useRef(false);
  // The record this part wrote to before the last change of record (a new reply target), if any.
  const previousKey = useRef<string | null>(null);
  const forget = useRef(() => {});
  forget.current = () => {
    if (!ownedStore.active()) return;
    if (family) { removeLocalDraftFamily(owner, family); return; }
    const form = holder.current?.closest("form");
    const preserving = Boolean(form?.dataset.draftPreserve);
    if (preserving || recovery.current && !decided.current) {
      const record = readLocalDraft(key);
      if (record && !keep(record)) return;
    }
    if (preserving && form) form.dataset.draftPreserve = "retained";
    removeLocalDraft(key);
    // Keep a newly protected source even if sending or discarding this screen
    // normally clears its set-asides. New-post recovery keeps them as before.
    if (!recovery.current && !preserving) {
      for (const shown of setAsideDrafts(key, ownedStore)) removeShownDraft(shown, ownedStore);
    }
  };
  const navigation = useNavigation();
  const location = useLocation();

  useEffect(() => { leaving.current = false; return () => { leaving.current = true; }; }, []);

  useEffect(() => {
    const form = holder.current?.closest("form");
    if (!form) return;
    rememberDraftOwner(owner);
    const write = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      if (accepted.current || !ownedStore.active()) return;
      // Recovery owns the old link until it has compared the original record
      // with native edits. Never overwrite that evidence while activation waits.
      if (!decided.current && (recovery.current || form.dataset.autosave === "ready")) return;
      const { title, body } = fieldsOf(form);
      if (!body) return;
      const current = { title: title?.value ?? "", body: body.value };
      const previous = readLocalDraft(key);
      // If recovery could not set aside its source (for example, quota), retry
      // before replacing it. Typing continues; the notice says it is not saved.
      if (previous && (form.dataset.draftPreserve || previous.base !== (form.dataset.draftBase ?? base)) && !keep(previous)) return;
      const server = previous?.server;
      if (baseOf(current.title, current.body) === base && !server) { removeLocalDraft(key); setSaved(false); return; }
      if (writeLocalDraft(key, { ...(title ? { title: current.title } : {}), body: current.body, base: form.dataset.draftBase ?? base, savedAt: Date.now(), ...(server ? { server } : {}) })) {
        setFailed(false);
        setSaved(true);
        clearTimeout(fade.current);
        fade.current = setTimeout(() => setSaved(false), 4000);
      } else setFailed(true);
    };
    const schedule = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) || (target.name !== "title" && target.name !== "body")) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(write, SAVE_DELAY_MS);
    };
    const flush = () => { if (timer.current !== undefined) write(); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    form.addEventListener("input", schedule);
    // The member chose to leave the page and discard what was typed (the confirmation of the unsaved-writing guard).
    const discarded = () => { accepted.current = true; clearTimeout(timer.current); timer.current = undefined; forget.current(); };
    form.addEventListener("tomola:form-discarded", discarded);
    // Text typed before this part was loaded (it loads after the page is ready) has had no input event to be kept by.
    const typedBefore = fieldsOf(form);
    const typedHere = typedBefore.body ? { title: typedBefore.title?.value ?? "", body: typedBefore.body.value } : null;
    const familyId = family ? `${owner}:${family}` : null;
    const priorKey = previousKey.current ?? (familyId ? lastKeyOfFamily.get(familyId) ?? null : null);
    const changedFrom = priorKey !== null && priorKey.startsWith(localDraftKey(owner, "")) && priorKey !== key ? priorKey : null;
    previousKey.current = key;
    if (familyId) lastKeyOfFamily.set(familyId, key);
    if (changedFrom !== null) {
      // The record changed under the form (another reply target): what was typed goes to the new record at once, and the old record, if it holds the same text, goes. An older state of the
      // old record is not shown for the new one.
      setRestored(null);
      setOlder([]);
      if (typedHere && baseOf(typedHere.title, typedHere.body) !== base) {
        const existing = readLocalDraft(key);
        const protectedTarget = !existing || existing.body === typedHere.body && orBlank(existing.title) === (typedBefore.title ? typedHere.title : "") || keep(existing);
        if (protectedTarget) write();
        const before = readLocalDraft(changedFrom);
        const written = readLocalDraft(key);
        if (protectedTarget && written?.body === typedHere.body && orBlank(written.title) === (typedBefore.title ? typedHere.title : "") && before && before.body === typedHere.body && orBlank(before.title) === (typedBefore.title ? typedHere.title : "")) removeLocalDraft(changedFrom);
      }
    } else if (typedHere && baseOf(typedHere.title, typedHere.body) !== base && !readLocalDraft(key)) timer.current = setTimeout(write, SAVE_DELAY_MS);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    const invalidated = () => {
      if (ownedStore.active()) return;
      accepted.current = true;
      clearTimeout(timer.current);
      timer.current = undefined;
      clearTimeout(fade.current);
      decided.current = null;
      setRestored(null);
      setOlder([]);
      setFailed(false);
      setSaved(false);
      const { title, body } = fieldsOf(form);
      if (title) title.value = startingText.current.title ?? "";
      if (body) replaceEditorBody(body, startingText.current.body);
      recovery.current?.(null);
    };
    window.addEventListener("storage", invalidated);
    const changedAside = (event: Event) => { if (event.type === "storage" && !(event as StorageEvent).key?.includes("~older:")) return;
      if (ownedStore.active()) setOlder(before => {
      const records = setAsideDrafts(key, ownedStore), shown = before[0];
      return shown ? [shown, ...records.filter(item => item.key !== shown.key || !sameDraft(item.record, shown.record))] : records;
    }); };
    window.addEventListener("storage", changedAside);
    window.addEventListener("tomola:draft-set-aside", changedAside);
    window.addEventListener("tomola:drafts-cleared", invalidated);
    const decide = () => {
      if (!ownedStore.active()) return;
      if (recovery.current && decided.current?.key === key && decided.current.base === base && decided.current.store === store) return;
      decided.current = { key, base, store };
      refreshOlder();
      const record = readLocalDraft(key);
      if (!record) { recovery.current?.(null); return; }
      const { title, body } = fieldsOf(form);
      if (!body) { recovery.current?.(null); return; }
      const current = { title: title?.value ?? "", body: body.value };
      // Autosave can acknowledge new writing before this lazy keeper starts.
      // Compare recovery with that acknowledged base, rather than loader text.
      const currentBase = form.dataset.draftBase ?? base;
      // A record made on other starting text is not put back by itself: it is set aside and offered. And a record goes only onto the text the screen started from: anything typed since
      // (or a refused form's text, which is the record itself) is more recent.
      const sameWriting = current.title === orBlank(record.title) && current.body === record.body;
      // History traversal may already have restored these exact fields before scripts load.
      if (record.base !== currentBase || recovery.current && baseOf(current.title, current.body) !== currentBase && !sameWriting) {
        if (keep(record)) { removeLocalDraft(key); refreshOlder(); }
        else { recovery.current?.(null); return; }
        if (recovery.current) { if (baseOf(current.title, current.body) !== currentBase) write(); recovery.current(null); }
        return;
      }
      if (baseOf(current.title, current.body) !== currentBase) { recovery.current?.(record); return; }
      const nextTitle = record.title ?? current.title;
      if (nextTitle === current.title && record.body === current.body) { recovery.current?.(record); return; }
      const originalFields = new FormData(form);
      if (title && nextTitle !== current.title) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, nextTitle);
        title.dispatchEvent(new Event("input", { bubbles: true }));
      }
      replaceEditorBody(body, record.body);
      setRestored({ at: record.savedAt, original: current, fields: originalFields });
      recovery.current?.(record);
    };
    const cancel = afterInitialActivation(() => {
      try { decide(); }
      finally {
        form.dataset.draftRecovery = "ready";
        form.dispatchEvent(new Event("tomola:draft-recovery-ready"));
      }
    });
    return () => {
      cancel();
      delete form.dataset.draftRecovery;
      clearTimeout(fade.current);
      form.removeEventListener("input", schedule);
      form.removeEventListener("tomola:form-discarded", discarded);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("storage", invalidated);
      window.removeEventListener("storage", changedAside);
      window.removeEventListener("tomola:draft-set-aside", changedAside);
      window.removeEventListener("tomola:drafts-cleared", invalidated);
      // What is waiting to be written goes to the record when the part leaves the page; when the record changes under it (a new reply target) the wait is dropped, and the new effect
      // writes the text to the new record at once.
      if (timer.current !== undefined) {
        if (leaving.current) write();
        else { clearTimeout(timer.current); timer.current = undefined; }
      }
    };
  }, [key, base, owner, family, store, ownedStore, readLocalDraft, writeLocalDraft, removeLocalDraft, keep, refreshOlder]);

  // The server accepted the form: it answered with a redirect to another address, and the browser is loading that page. An answer that stays on this address (a refused form, a save
  // that stays on the screen) is not it, and neither is a redirect to a sign-in page.
  useEffect(() => {
    if (navigation.state !== "loading" || !navigation.formData?.has("body") || !navigation.location) return;
    if (navigation.formData.get("intent") === "respond") return;
    if (navigation.location.pathname === location.pathname && navigation.location.search === location.search) return;
    if (/^\/(login|suspended|onboarding|logout)(\/|$)/.test(navigation.location.pathname)) return;
    accepted.current = true;
    clearTimeout(timer.current);
    timer.current = undefined;
    forget.current();
  }, [navigation.state, navigation.formData, navigation.location, location.pathname, location.search, key]);

  // Put the set-aside writing into the fields, as the restored one is, so that it can be discarded the same way.
  function openOlder() {
    const shown = older[0];
    const record = shown?.record;
    const form = holder.current?.closest("form");
    const { title, body } = fieldsOf(form);
    if (!ownedStore.active() || !record || !body) return;
    const currentBase = form?.dataset.draftBase ?? base;
    const original = { title: title?.value ?? "", body: body.value };
    const originalFields = new FormData(form!);
    const current = readLocalDraft(key);
    const preserve = recovery.current ? current?.pending !== false || current.body !== original.body || orBlank(current.title) !== original.title : baseOf(original.title, original.body) !== base;
    // Capture the last keystrokes and options before detaching autosave. Keep
    // them as an independent record before opening the offered writing.
    const displaced = { ...current, ...original, base: currentBase, savedAt: Date.now(), ...(form ? { fields: JSON.stringify([...new FormData(form)].filter(([name]) => ["title", "body", "lang", "asksStance", "stanceTag", "intro", "village", "villageExplicit", "altOf", "editVersion"].includes(name))), ...(recovery.current ? { pending: true } : {}) } : {}) };
    // Protect a distinct pending device record as well as the live keystrokes.
    // Nothing is detached, replaced or deleted until both copies are durable.
    if (current && (current.body !== original.body || orBlank(current.title) !== original.title) && !keep(current)) return;
    if (preserve && (original.body.trim() || original.title.trim()) && !keep(displaced)) return;
    const writeOpened = () => ownedStore.active() && (store.writeDurable ?? writeLocalDraft)(key, { ...record, base: currentBase });
    if (!writeOpened()) { setFailed(true); return; }
    if (recovery.current) form?.dispatchEvent(new Event("tomola:draft-detached"));
    if (title && record.title !== undefined) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, record.title);
      title.dispatchEvent(new Event("input", { bubbles: true }));
    }
    replaceEditorBody(body, record.body);
    // It is the live record of this screen from now on (on the text the screen starts from now).
    removeShownDraft(shown, ownedStore);
    refreshOlder();
    setFailed(false);
    setRestored({ at: record.savedAt, original, fields: originalFields });
    recovery.current?.({ ...record, base: currentBase });
  }
  function dropOlder() { if (!ownedStore.active() || !older[0]) return; removeShownDraft(older[0], ownedStore); refreshOlder(); }

  function discard() {
    if (!restored || !ownedStore.active()) return;
    if (recovery.current) holder.current?.closest("form")?.dispatchEvent(new Event("tomola:draft-detached"));
    clearTimeout(timer.current);
    timer.current = undefined;
    const form = holder.current?.closest("form");
    const { title, body } = fieldsOf(form);
    if (title) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, restored.original.title);
      title.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (body) replaceEditorBody(body, restored.original.body);
    // Every record of the screen family goes (the reply field keeps one per reply target), not only this one. A record set aside is a different thing and stays.
    const server = readLocalDraft(key)?.server;
    if (server && !recovery.current) writeLocalDraft(key, { ...restored.original, base: form?.dataset.draftBase ?? base, savedAt: Date.now(), server });
    else removeLocalDraft(key);
    if (family) removeLocalDraftFamily(owner, family);
    setRestored(null);
    setSaved(false);
    onDiscard?.(restored.fields);
    if (recovery.current) onLanguageChange?.(String(restored.fields.get("lang") ?? ""));
    recovery.current?.(null);
  }

  return <div ref={holder} data-draft-keeper className="ui-help text-muted-foreground">
    <p role="status" className="empty:hidden">
      {restored
        ? <>{m.local_draft_restored({ time: new Date(restored.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) })} <button type="button" className="underline" onClick={discard}>{m.local_draft_discard()}</button></>
        : saved ? m.local_draft_saved() : null}
    </p>
    {failed && <p role="alert">{m.local_draft_failed()}</p>}
    {older[0] && <p role="status">{m.local_draft_older({ time: new Date(older[0].record.savedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) })} <button type="button" className="underline" onClick={openOlder}>{m.local_draft_open()}</button> <button type="button" className="underline" onClick={dropOlder}>{m.local_draft_discard()}</button>{older.length > 1 && <QuietBoundary><Suspense fallback={null}><OlderDraftNavigation count={older.length} next={() => setOlder(items => [...items.slice(1), items[0]])} /></Suspense></QuietBoundary>}</p>}
  </div>;
}
