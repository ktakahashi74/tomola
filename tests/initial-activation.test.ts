import { afterEach, beforeEach, expect, it, vi } from "vitest";

let documentTarget: EventTarget & { visibilityState: string };
let windowTarget: EventTarget;
let frames: Map<number, FrameRequestCallback>;
let active: boolean;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  active = false;
  documentTarget = Object.assign(new EventTarget(), { querySelector: () => active ? {} : null, visibilityState: "visible" });
  windowTarget = new EventTarget();
  frames = new Map();
  let id = 0;
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal("window", windowTarget);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const pointer = (type: string, id = 1) => documentTarget.dispatchEvent(Object.assign(new Event(type), { pointerId: id }));
const key = (type: string, key: string, modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">> = {}) => documentTarget.dispatchEvent(Object.assign(new Event(type), { key, ...modifiers }));
function frame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); }

it("reports a failed deferred callback and still runs the remaining callbacks once", async () => {
  const { trackInitialActivation, afterInitialActivation } = await import("~/lib/initial-activation");
  const report = vi.fn(), remaining = vi.fn();
  vi.stubGlobal("reportError", report);
  trackInitialActivation();
  pointer("pointerdown");
  const error = new Error("Deferred recovery failed");
  afterInitialActivation(() => { throw error; });
  afterInitialActivation(remaining);
  pointer("pointerup"); frame();
  expect(report).toHaveBeenCalledWith(error);
  expect(remaining).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  frame(); vi.advanceTimersByTime(2000);
  expect(remaining).toHaveBeenCalledTimes(1);
});

it("runs ordinary initialization immediately and defers updates until pointer activation ends", async () => {
  const { trackInitialActivation, afterInitialActivation } = await import("~/lib/initial-activation");
  trackInitialActivation();
  const update = vi.fn();
  afterInitialActivation(update);
  expect(update).toHaveBeenCalledTimes(1);
  pointer("pointerdown");
  afterInitialActivation(update);
  frame();
  expect(update).toHaveBeenCalledTimes(1);
  pointer("pointerup");
  expect(update).toHaveBeenCalledTimes(1);
  frame();
  expect(update).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["pointer", "key", "before scripts", "finishing", "input"])("bounds a missing %s release to two seconds without extending the deadline", async kind => {
  active = kind === "before scripts";
  const { trackInitialActivation, afterInitialActivation } = await import("~/lib/initial-activation");
  trackInitialActivation();
  if (kind === "pointer" || kind === "finishing") pointer("pointerdown");
  if (kind === "key") key("keydown", "Enter");
  if (kind === "input") documentTarget.dispatchEvent(new Event("beforeinput"));
  const update = vi.fn(), later = vi.fn(), cancelled = vi.fn();
  afterInitialActivation(update);
  afterInitialActivation(cancelled)();
  if (kind === "finishing") pointer("pointerup");
  vi.advanceTimersByTime(1500);
  afterInitialActivation(later);
  vi.advanceTimersByTime(499);
  expect(update).not.toHaveBeenCalled();
  expect(later).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(update).toHaveBeenCalledTimes(1);
  expect(later).toHaveBeenCalledTimes(1);
  expect(cancelled).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  afterInitialActivation(update);
  expect(update).toHaveBeenCalledTimes(2);
  frame(); vi.advanceTimersByTime(2000);
  expect(update).toHaveBeenCalledTimes(2);
});

it.each(["insertText", "insertFromPaste", "insertCompositionText"])("keeps %s separate from writing restored during beforeinput", async inputType => {
  const { trackInitialActivation, afterInitialActivation } = await import("~/lib/initial-activation");
  trackInitialActivation();
  let body = "";
  documentTarget.addEventListener("beforeinput", () => {
    afterInitialActivation(() => { if (body === "") body = "Recovered writing."; });
  });
  documentTarget.dispatchEvent(Object.assign(new Event("beforeinput"), { inputType }));
  // The browser's default edit follows beforeinput and precedes input.
  body += "New writing.";
  documentTarget.dispatchEvent(new Event("input"));
  expect(body).toBe("New writing.");
  frame();
  expect(body).toBe("New writing.");
  expect(vi.getTimerCount()).toBe(0);
});

it("releases recovery after a cancelled beforeinput without needing an input event", async () => {
  const { trackInitialActivation, afterInitialActivation } = await import("~/lib/initial-activation");
  trackInitialActivation();
  documentTarget.addEventListener("beforeinput", event => event.preventDefault());
  documentTarget.dispatchEvent(new Event("beforeinput", { cancelable: true }));
  const restore = vi.fn();
  afterInitialActivation(restore);
  expect(restore).not.toHaveBeenCalled();
  frame();
  expect(restore).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a press begun before scripts held while an input event finishes", async () => {
  active = true;
  const { trackInitialActivation, afterInitialActivation } = await import("~/lib/initial-activation");
  trackInitialActivation();
  documentTarget.dispatchEvent(new Event("beforeinput"));
  const update = vi.fn();
  afterInitialActivation(update);
  frame();
  expect(update).not.toHaveBeenCalled();
  pointer("pointerup"); frame();
  expect(update).toHaveBeenCalledTimes(1);
});

it.each(["metaKey", "ctrlKey", "altKey"] as const)("does not hold initialization for Enter or Space with %s", async modifier => {
  const { trackInitialActivation, afterInitialActivation } = await import("~/lib/initial-activation");
  trackInitialActivation();
  const update = vi.fn();
  for (const value of ["Enter", " "]) {
    key("keydown", value, { [modifier]: true });
    afterInitialActivation(update);
  }
  expect(update).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["pageshow", "visibilitychange", "blur"])("clears held activations and queued frames on %s", async kind => {
  const { trackInitialActivation, afterInitialActivation } = await import("~/lib/initial-activation");
  trackInitialActivation();
  const update = vi.fn();
  pointer("pointerdown"); key("keydown", "Enter");
  afterInitialActivation(update);
  pointer("pointerup");
  windowTarget.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  expect(update).not.toHaveBeenCalled();
  if (kind === "pageshow") windowTarget.dispatchEvent(Object.assign(new Event(kind), { persisted: true }));
  else if (kind === "visibilitychange") {
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event(kind));
  } else windowTarget.dispatchEvent(new Event(kind));
  expect(update).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  afterInitialActivation(update);
  expect(update).toHaveBeenCalledTimes(2);
  frame(); vi.advanceTimersByTime(2000);
  expect(update).toHaveBeenCalledTimes(2);
});
it("keeps multi-pointer and keyboard activations intact and cancels unmounted work", async () => {
  const { trackInitialActivation, afterInitialActivation } = await import("~/lib/initial-activation");
  trackInitialActivation();
  const update = vi.fn();
  pointer("pointerdown", 1); pointer("pointerdown", 2);
  const cancel = afterInitialActivation(update);
  pointer("pointerup", 1); frame();
  expect(update).not.toHaveBeenCalled();
  cancel(); pointer("pointercancel", 2); frame();
  expect(update).not.toHaveBeenCalled();
  key("keydown", " "); afterInitialActivation(update); frame();
  expect(update).not.toHaveBeenCalled();
  key("keyup", " "); frame();
  expect(update).toHaveBeenCalledTimes(1);
});
it("adopts a press begun before scripts and releases it on cancellation or loss of focus", async () => {
  active = true;
  const { trackInitialActivation, afterInitialActivation } = await import("~/lib/initial-activation");
  trackInitialActivation(); trackInitialActivation();
  const update = vi.fn();
  afterInitialActivation(update);
  expect(update).not.toHaveBeenCalled();
  pointer("pointercancel"); frame();
  expect(update).toHaveBeenCalledTimes(1);
  pointer("pointerdown"); afterInitialActivation(update);
  windowTarget.dispatchEvent(new Event("blur"));
  expect(update).toHaveBeenCalledTimes(2);
});
