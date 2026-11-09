import { useSyncExternalStore } from "react";
import { guideDismissed, isIosSafari, rememberGuideDismissed, standaloneDisplay } from "./install-guide";

type InstallPrompt = Event & { prompt(): Promise<{ outcome: "accepted" | "dismissed" }> };
let prompt: InstallPrompt | null = null;
let dismissed = false;
let installed = false;
let revision = 0;
const listeners = new Set<() => void>();
function changed() { revision++; for (const listener of listeners) listener(); }
function storage() {
  try { return window.localStorage; } catch { return null; }
}

// Listen as soon as a home/settings route loads, before a lazy notice is read.
// These routes share the retained event across client-side navigation.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", event => {
    if (!("prompt" in event) || typeof event.prompt !== "function") return;
    if (listeners.size > 0) event.preventDefault();
    prompt = event as InstallPrompt;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    prompt = null;
    dismissInstallGuide();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const display = window.matchMedia("(display-mode: standalone)");
  const pointer = window.matchMedia("(pointer: coarse)");
  // One handler per subscription, so removing one subscription leaves the others listening.
  const onChange = () => changed();
  display.addEventListener("change", onChange);
  pointer.addEventListener("change", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(listener);
    display.removeEventListener("change", onChange);
    pointer.removeEventListener("change", onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useInstallGuide() {
  const version = useSyncExternalStore(subscribe, () => revision, () => -1);
  return version === -1 ? null : {
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
    iosSafari: isIosSafari(navigator),
    standalone: standaloneDisplay(),
    canPrompt: prompt !== null,
    installed,
    dismissed: dismissed || guideDismissed(storage()),
  };
}

export function dismissInstallGuide() {
  dismissed = true;
  rememberGuideDismissed(storage());
  changed();
}

export async function promptInstall() {
  const event = prompt;
  if (!event) return;
  // The browser allows one call per retained event, from a user gesture only.
  prompt = null;
  const result = event.prompt();
  changed();
  if ((await result).outcome === "accepted") {
    installed = true;
    dismissInstallGuide();
  }
}
