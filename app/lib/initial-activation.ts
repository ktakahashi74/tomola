// Hydration can run synchronously during pointerdown. Browser-only additions
// must not move that pointer's target before pointerup/click has completed.
const pending = new Set<() => void>();
const pointers = new Set<number>();
const keys = new Set<string>();
let heldBeforeScripts = false;
let installed = false;
let frame = 0;
let finishing = false;
let deadline: ReturnType<typeof setTimeout> | undefined;

function flush() {
  clearTimeout(deadline);
  deadline = undefined;
  const callbacks = [...pending];
  pending.clear();
  for (const callback of callbacks) {
    try { callback(); } catch (error) { reportError(error); }
  }
}

function reset() {
  pointers.clear();
  keys.clear();
  heldBeforeScripts = false;
  finishing = false;
  cancelAnimationFrame(frame);
  flush();
}

export function trackInitialActivation() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  heldBeforeScripts = document.querySelector(":active") !== null;
  document.addEventListener("pointerdown", event => { pointers.add(event.pointerId); }, true);
  const release = () => {
    heldBeforeScripts = false;
    finishing = true;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (pointers.size || keys.size || heldBeforeScripts) return;
      finishing = false;
      flush();
    });
  };
  const pointerRelease = (event: PointerEvent) => { pointers.delete(event.pointerId); release(); };
  document.addEventListener("pointerup", pointerRelease, true);
  document.addEventListener("pointercancel", pointerRelease, true);
  document.addEventListener("keydown", event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === " " || event.key === "Enter") keys.add(event.key);
  }, true);
  document.addEventListener("keyup", event => {
    if (keys.delete(event.key) || heldBeforeScripts) release();
  }, true);
  window.addEventListener("blur", reset);
  window.addEventListener("pageshow", event => { if (event.persisted) reset(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") reset();
  });
}

export function afterInitialActivation(callback: () => void): () => void {
  if (pointers.size || keys.size || heldBeforeScripts || finishing) {
    pending.add(callback);
    // Missing release events must not leave browser-only controls hidden.
    deadline ??= setTimeout(reset, 2000);
  }
  else callback();
  return () => { pending.delete(callback); };
}
