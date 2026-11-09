import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useActionData, useLocation, useNavigation } from "react-router";
import { baseOf, draftStoreForOwner, orBlank, localDraftKey, localDraftStore, type DraftStore, type LocalDraft, type ServerDraftLink } from "~/lib/local-draft";
import { keepDraft } from "~/lib/set-aside-drafts";
import type { AutosavedDraft, AutosaveRequest } from "~/lib/draft-autosave";
import { m } from "~/paraglide/messages.js";
import { FormLanguageChangeContext } from "~/components/form-contexts";
import { afterInitialActivation } from "~/lib/initial-activation";
import { Button } from "~/components/ui/button";

const DELAY = 2500;
const fields = new Set(["title", "body", "lang", "asksStance", "stanceTag", "intro", "village", "villageExplicit", "altOf"]);
const snapshotOf = (data: FormData) => JSON.stringify([...data].filter(([name]) => fields.has(name)).map(([name, value]) => [name, name === "village" && data.get("villageExplicit") === "0" ? "" : value]));
const capture = (form: HTMLFormElement) => snapshotOf(new FormData(form));
// Departure checks keep the existing whitespace rules; saves and replay detection use exact text.
const comparable = (snapshot: string) => {
  try { return JSON.stringify((JSON.parse(snapshot) as [string, string][]).map(([name, value]) => [name, name === "title" || name === "body" ? value.replace(/\r\n?/g, "\n").trim() : value])); }
  catch { return snapshot; }
};
type SavedAction = { saved?: boolean; version?: number; signingView?: string; altRemoved?: boolean; error?: string | null };
const unpack = (snapshot: string) => {
  const form = new FormData();
  for (const [name, value] of JSON.parse(snapshot) as [string, string][]) form.append(name, value);
  return form;
};

export default function DraftAutosave({ owner, scope, startTitle = "", startBody, draft, onSaved, onLinked, onRestore, newTopic = false, store = localDraftStore, recovered, recoveryToken }: {
  owner: string; scope: string; startTitle?: string; startBody: string; draft?: { id: number; version: number };
  onSaved?: (saved: AutosavedDraft) => void; onLinked?: (id: number | undefined) => void; onRestore?: (fields: FormData) => void; newTopic?: boolean; store?: DraftStore; recovered?: LocalDraft | null;
  recoveryToken?: string;
}) {
  const ownedStore = useMemo(() => draftStoreForOwner(owner, store), [owner, store]);
  const { read: readLocalDraft, write: writeLocalDraft, remove: removeLocalDraft } = ownedStore;
  const holder = useRef<HTMLParagraphElement>(null);
  const callback = useRef(onSaved);
  callback.current = onSaved;
  const linkedCallback = useRef(onLinked);
  linkedCallback.current = onLinked;
  const restoreCallback = useRef(onRestore);
  restoreCallback.current = onRestore;
  const language = useContext(FormLanguageChangeContext);
  const [status, setStatus] = useState<"" | "saving" | "saved" | "failed" | "missing">("");
  const [copied, setCopied] = useState(false);
  const [missing, setMissing] = useState(false);
  const [localFailed, setLocalFailed] = useState(false);
  const recoverMissing = useRef<(() => void) | null>(null);
  const navigation = useNavigation();
  const action = useActionData<SavedAction>();
  const submitted = useRef<string | null>(null);
  const acknowledge = useRef<((snapshot: string, action: SavedAction) => void) | null>(null);
  const location = useLocation();
  const stopped = useRef(false);
  const forgetLocal = useRef((_leaving = true) => {});
  const link = useRef<ServerDraftLink | undefined>(draft);
  const paused = useRef(false);
  const lastSaved = useRef<AutosavedDraft | null>(null);
  const initialDraft = useRef(draft);
  initialDraft.current = draft;
  useEffect(() => {
    const element = holder.current?.closest("form");
    if (!element) return;
    const form: HTMLFormElement = element;
    let key = localDraftKey(owner, scope);
    const loaderBase = baseOf(startTitle, startBody);
    let base = loaderBase;
    const record = newTopic ? recovered : readLocalDraft(key);
    const keep = (value: LocalDraft) => {
      const written = keepDraft(key, value, ownedStore);
      setLocalFailed(!written);
      if (written) delete form.dataset.draftPreserve;
      else form.dataset.draftPreserve = "blocked";
      return written;
    };
    forgetLocal.current = (leaving = true) => {
      const previous = readLocalDraft(key);
      const preserving = Boolean(form.dataset.draftPreserve);
      if (preserving && previous && !keep(previous)) return;
      // The keeper can clean up after this listener. Keep the obligation
      // visible until the form leaves so it cannot clear the protected copy.
      if (preserving && leaving) form.dataset.draftPreserve = "retained";
      removeLocalDraft(key);
    };
    const rememberedServer = record?.server && (newTopic || record.server.id === initialDraft.current?.id && record.server.version === initialDraft.current.version) ? record.server : undefined;
    if (!newTopic && record?.server && !rememberedServer) {
      if (keep(record)) removeLocalDraft(key);
    }
    const cancelRestore = afterInitialActivation(() => {
      const remembered = record?.fields ?? rememberedServer?.attempted ?? rememberedServer?.snapshot;
      if (newTopic && record && remembered) {
        const current = new FormData(form);
        const text = baseOf(String(current.get("title") ?? ""), String(current.get("body") ?? ""));
        if (text === base || text === baseOf(record.title, record.body)) {
          try {
            const restored = unpack(remembered);
            restoreCallback.current?.(restored);
            language?.current?.(String(restored.get("lang") ?? ""));
          } catch { /* A damaged device record cannot change the writing controls. */ }
        }
      }
    });
    link.current = rememberedServer ?? initialDraft.current;
    stopped.current = false;
    paused.current = false;
    let attempted = rememberedServer?.attempted;
    let verified = !newTopic;
    let pending: Promise<AutosavedDraft | null> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let fork = false;
    let observed = capture(form);
    const initial = new FormData(form);
    if (initial.has("title")) initial.set("title", startTitle);
    initial.set("body", startBody);
    const pristine = snapshotOf(initial);
    // Loading this helper can finish after native edits. Only the server's
    // starting text, not those edits, has already been acknowledged.
    let snapshot = rememberedServer?.snapshot ?? (initialDraft.current ? pristine : "");
    if (!newTopic) form.dataset.draftBase = base;
    let recoveryProtected = newTopic;
    const persist = () => {
      if (stopped.current || !ownedStore.active() || !newTopic && !link.current) return;
      const current = new FormData(form);
      const title = String(current.get("title") ?? ""), body = String(current.get("body") ?? "");
      // Unchanged loader text must wait for recovery. New edits can be kept
      // immediately, but first protect any writing the keeper has not restored.
      if (!newTopic && form.dataset.draftRecovery !== "ready" && base === loaderBase && baseOf(title, body) === loaderBase) return;
      if (!recoveryProtected || form.dataset.draftPreserve) {
        const previous = readLocalDraft(key);
        // A copy of the acknowledged server text is not unsent writing.
        if (previous && (form.dataset.draftPreserve || baseOf(previous.title, previous.body) !== base && (orBlank(previous.title) !== title || previous.body !== body))
          && !keep(previous)) return;
        recoveryProtected = true;
      }
      const written = writeLocalDraft(key, { title, body, base, savedAt: Date.now(),
        ...(newTopic ? { fields: capture(form), pending: capture(form) !== snapshot } : {}),
        ...(link.current ? { server: { ...link.current, snapshot, attempted } } : {}) });
      setLocalFailed(!written);
    };
    const setField = (name: string, value: string) => {
      let input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (!input) { input = document.createElement("input"); input.type = "hidden"; input.name = name; input.dataset.autosaveLink = ""; form.append(input); }
      input.value = value;
    };
    const unlink = (forget = true) => {
      link.current = undefined;
      lastSaved.current = null;
      attempted = undefined;
      snapshot = pristine;
      fork = false;
      verified = false;
      linkedCallback.current?.(undefined);
      for (const input of form.querySelectorAll<HTMLInputElement>('input[data-autosave-link]')) input.remove();
      if (forget) forgetLocal.current(false);
    };
    if (newTopic && !link.current) unlink(false);
    const attach = (saved: AutosavedDraft | ServerDraftLink, notify = true) => {
      if (!newTopic && link.current && saved.id !== link.current.id) {
        const previous = readLocalDraft(key);
        const current = new FormData(form);
        if (previous?.server?.id === link.current.id && previous.body === current.get("body") && orBlank(previous.title) === (current.get("title") ?? "")) removeLocalDraft(key);
        key = localDraftKey(owner, `draft:${saved.id}`);
        if ("body" in saved) base = baseOf(saved.title, saved.body);
      }
      link.current = { id: saved.id, version: saved.version };
      linkedCallback.current?.(saved.id);
      if (newTopic) { setField("fromDraft", String(saved.id)); setField("fromDraftVersion", String(saved.version)); }
      else setField("version", String(saved.version));
      if ("signingView" in saved) {
        setField("signingView", saved.signingView);
        if (notify) callback.current?.(saved);
      }
    };
    if (link.current) {
      attach(link.current);
      if (verified && snapshot === capture(form)) {
        setStatus("saved");
        form.dispatchEvent(new CustomEvent("tomola:form-saved", { detail: unpack(snapshot) }));
      }
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void save(); }, DELAY); };
    acknowledge.current = (sent, result) => {
      const values = unpack(sent);
      if (result.altRemoved) values.delete("altOf");
      snapshot = snapshotOf(values);
      attempted = undefined;
      if (link.current && result.version !== undefined) {
        link.current.version = result.version;
        setField("version", String(result.version));
        if (result.signingView) setField("signingView", result.signingView);
      }
      if (result.error === "draft_conflict" || result.error === "not_found") { snapshot = ""; attempted = sent; }
      else if (!newTopic) { base = baseOf(String(values.get("title") ?? ""), String(values.get("body") ?? "")); form.dataset.draftBase = base; }
      persist();
      setStatus(capture(form) === snapshot ? "saved" : "saving");
    };
    async function save(leaving = false, force = false, round = 0, recovering = false): Promise<AutosavedDraft | null> {
      clearTimeout(timer);
      if (stopped.current || paused.current || disposed) return null;
      if (pending) {
        await pending;
        return save(leaving, force, round, recovering);
      }
      const captured = capture(form);
      const values = new FormData(form);
      if (newTopic && !link.current && !force && baseOf(String(values.get("title") ?? ""), String(values.get("body") ?? "")) === base) { setStatus(""); return null; }
      if (!String(values.get("title") ?? "").trim() && !String(values.get("body") ?? "").trim()) { setStatus(""); return null; }
      if (captured === snapshot && !force && !fork) {
        if (!verified && link.current) {
          try {
            const response = await fetch(`/drafts/autosave?draftId=${link.current.id}`, { credentials: "same-origin", redirect: "manual", cache: "no-store" });
            if (disposed || stopped.current) return null;
            if (!response.ok) {
              if (response.status === 404 && newTopic) { unlink(); persist(); return save(leaving, true, round); }
              form.dataset.autosaveError = response.status === 401 ? "login_required" : response.status === 404 ? "not_found" : "busy";
              if (response.status === 404) setMissing(true);
              setStatus(response.status === 404 ? "missing" : "failed");
              return null;
            }
            verified = true;
          } catch { if (!disposed) setStatus("failed"); return null; }
        }
        if (capture(form) !== captured) { schedule(); return null; }
        persist();
        form.dispatchEvent(new CustomEvent("tomola:form-saved", { detail: unpack(captured) }));
        setStatus("saved");
        return lastSaved.current;
      }
      const previous = attempted;
      attempted = captured;
      persist();
      values.set("ownerId", owner);
      if (newTopic) values.set("newTopic", "1");
      if (link.current) { values.set("draftId", String(link.current.id)); values.set("version", String(link.current.version)); }
      if (previous) values.set("previous", previous);
      if (fork) values.set("fork", "1");
      if (recovering && recoveryToken) values.set("recoveryToken", recoveryToken);
      let retryConflict = false;
      let retryForce = false;
      delete form.dataset.autosaveError;
      setStatus("saving");
      pending = (async () => {
        try {
          const response = await fetch(`/drafts/autosave${recovering ? "?newdraft=1" : ""}`, { method: "POST", body: new URLSearchParams([...values] as [string, string][]), keepalive: leaving, credentials: "same-origin", redirect: "manual", cache: "no-store" });
          if (stopped.current || disposed) return null;
          if (response.status === 401 || response.type === "opaqueredirect") { form.dataset.autosaveError = "login_required"; throw new Error("Sign in required"); }
          const saved = await response.json() as AutosavedDraft & { error?: string; latest?: AutosavedDraft; previousMatches?: boolean };
          if (stopped.current || disposed) return null;
          if (saved.error === "draft_conflict" && saved.latest) {
            if (saved.previousMatches) {
              attach(saved.latest);
              snapshot = previous ?? snapshot;
              lastSaved.current = saved.latest;
            }
            else fork = true;
            retryConflict = true;
            persist();
            return null;
          }
          if (!response.ok || !Number.isSafeInteger(saved.id) || !Number.isSafeInteger(saved.version)) {
            form.dataset.autosaveError = saved.error ?? "busy";
            if (response.status === 404) {
              if (newTopic) { unlink(); persist(); retryConflict = true; retryForce = true; return null; }
              verified = false; setMissing(true); setStatus("missing"); return null;
            }
            throw new Error("Save failed");
          }
          fork = false;
          verified = true;
          setMissing(false);
          attach(saved, false);
          lastSaved.current = saved;
          snapshot = captured;
          attempted = undefined;
          if (!newTopic) { base = baseOf(saved.title, saved.body); form.dataset.draftBase = base; }
          persist();
          form.dispatchEvent(new CustomEvent("tomola:form-saved", { detail: unpack(captured) }));
          callback.current?.(saved);
          if (saved.copied) setCopied(true);
          setStatus(capture(form) === snapshot ? "saved" : "saving");
          return saved;
        } catch {
          if (!disposed && !stopped.current) { setStatus("failed"); persist(); }
          return null;
        } finally { pending = undefined; }
      })();
      const saved = await pending;
      if (!disposed && !paused.current && !stopped.current && retryConflict) {
        if (round < 3) return save(leaving, retryForce, round + 1);
        setStatus("failed");
      }
      if (saved && capture(form) !== snapshot) schedule();
      return saved;
    }
    recoverMissing.current = () => { if (!pending) void save(false, true, 0, true); };
    const changed = () => {
      if (disposed) return;
      const current = capture(form);
      if (current === observed) return;
      observed = current;
      if (!stopped.current) { if (newTopic) persist(); setStatus("saving"); schedule(); }
    };
    const observer = new MutationObserver(changed);
    const online = () => { if (!stopped.current && !paused.current) schedule(); };
    const hidden = () => { if (document.visibilityState === "hidden") void save(true); };
    const recoveryReady = () => persist();
    const flush = (event: Event) => {
      const detail = (event as CustomEvent<AutosaveRequest>).detail;
      const operation = save(detail.leaving, !detail.leaving);
      detail.pending = detail.leaving ? Promise.race([operation, new Promise<null>(resolve => setTimeout(() => resolve(null), 900))]) : operation;
    };
    const dirtiness = (event: Event) => {
      const values = new FormData(form);
      if (newTopic && !link.current && baseOf(String(values.get("title") ?? ""), String(values.get("body") ?? "")) === base) { (event as CustomEvent<{ dirty: boolean }>).detail.dirty = false; return; }
      (event as CustomEvent<{ dirty: boolean }>).detail.dirty = snapshot || newTopic && !link.current
        ? comparable(capture(form)) !== comparable(snapshot || pristine)
        : Boolean(String(values.get("title") ?? "").trim() || String(values.get("body") ?? "").trim());
    };
    const discard = () => { stopped.current = true; clearTimeout(timer); forgetLocal.current(); };
    // The keeper has already installed the opened writing durably. Detach the
    // old server link without removing that newly installed device record.
    const detached = () => { if (newTopic) { stopped.current = true; clearTimeout(timer); unlink(false); } };
    const pause = () => { paused.current = true; clearTimeout(timer); };
    const resume = () => { if (!stopped.current) { paused.current = false; schedule(); } };
    let submitting = false;
    let queued = false;
    const submit = (event: Event) => {
      if (submitting) return;
      clearTimeout(timer);
      if (!pending && !queued) { paused.current = true; return; }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (queued) return;
      queued = true;
      const button = (event as SubmitEvent).submitter as HTMLButtonElement | null;
      void save().finally(() => {
        if (disposed) return;
        paused.current = true;
        submitting = true;
        form.requestSubmit(button);
        submitting = false;
        queued = false;
      });
    };
    form.dataset.autosave = "ready";
    form.addEventListener("input", changed);
    form.addEventListener("change", changed);
    observer.observe(form, { subtree: true, childList: true, attributes: true, attributeFilter: ["value", "checked"] });
    form.addEventListener("submit", submit, true);
    form.addEventListener("tomola:autosave-flush", flush);
    form.addEventListener("tomola:autosave-dirty", dirtiness);
    form.addEventListener("tomola:autosave-resume", resume);
    form.addEventListener("tomola:form-discarded", discard);
    form.addEventListener("tomola:draft-detached", detached);
    form.addEventListener("tomola:draft-recovery-ready", recoveryReady);
    document.addEventListener("visibilitychange", hidden);
    const pagehide = () => { void save(true); };
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("online", online);
    window.addEventListener("tomola:discard-unsaved", pause);
    if (newTopic || capture(form) !== snapshot) schedule();
    return () => {
      disposed = true;
      acknowledge.current = null;
      recoverMissing.current = null;
      cancelRestore();
      clearTimeout(timer);
      delete form.dataset.autosave;
      form.removeEventListener("input", changed);
      form.removeEventListener("change", changed);
      observer.disconnect();
      form.removeEventListener("submit", submit, true);
      form.removeEventListener("tomola:autosave-flush", flush);
      form.removeEventListener("tomola:autosave-dirty", dirtiness);
      form.removeEventListener("tomola:autosave-resume", resume);
      form.removeEventListener("tomola:form-discarded", discard);
      form.removeEventListener("tomola:draft-detached", detached);
      form.removeEventListener("tomola:draft-recovery-ready", recoveryReady);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("online", online);
      window.removeEventListener("tomola:discard-unsaved", pause);
    };
  }, [owner, scope, startTitle, startBody, newTopic, language, recovered, recoveryToken, ownedStore, readLocalDraft, writeLocalDraft, removeLocalDraft]);
  useEffect(() => {
    if (action?.error === "not_found") { setMissing(true); setStatus("missing"); }
  }, [action]);
  useEffect(() => {
    const form = holder.current?.closest("form");
    if (navigation.state !== "idle") {
      if (form && navigation.formData?.has("body") && navigation.formAction && new URL(navigation.formAction, window.location.href).pathname === new URL(form.action).pathname) submitted.current = snapshotOf(navigation.formData);
    } else if (submitted.current !== null) {
      if (action?.saved) acknowledge.current?.(submitted.current, action);
      submitted.current = null;
    }
  }, [navigation.state, navigation.formData, navigation.formAction, action]);
  useEffect(() => {
    if (navigation.state === "loading" && (navigation.formData?.has("body") || navigation.formData?.get("intent") === "delete") && navigation.location?.pathname !== location.pathname && !/^\/(login|suspended|onboarding)/.test(navigation.location?.pathname ?? "")) {
      stopped.current = true;
      forgetLocal.current();
    }
    if (navigation.state === "idle") paused.current = false;
  }, [navigation.state, navigation.location, navigation.formData, location.pathname, owner, scope, removeLocalDraft]);
  return <p ref={holder} data-draft-autosave={status} className="ui-help text-muted-foreground">
    <span aria-live="off">{status === "saving" ? m.draft_autosave_saving() : status === "saved" ? m.draft_autosave_saved() : ""}</span>
    <span aria-live="polite">{status === "failed" ? m.draft_autosave_failed() : status === "missing" ? m.ai_write_gone() : ""}</span>
    <span aria-live="polite">{copied && <> {m.draft_autosave_copied()}</>}</span>
    {localFailed && <span role="alert"> {m.local_draft_failed()}</span>}
    {!newTopic && recoveryToken && missing && <> <Button type="button" variant="outline" disabled={status === "saving"} onClick={() => recoverMissing.current?.()}>{m.save_draft_as_new()}</Button></>}
  </p>;
}
