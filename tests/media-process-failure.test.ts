import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MEDIA_LIMITS } from "~/lib/media";
const spawned = vi.hoisted(() => ({ child: null as any }));
const status = vi.hoisted(() => ({ readFile: vi.fn(async () => "VmRSS:\t100 kB") }));
vi.mock("node:child_process", () => ({ spawn: () => spawned.child }));
vi.mock("node:fs/promises", () => status);
import { readMediaForm, rewriteMedia } from "~/lib/media-processing.server";
function child() {
  const process = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => process.emit("close", null, "SIGKILL")); return true; }) });
  spawned.child = process; return process;
}
beforeEach(() => { vi.spyOn(globalThis.process, "kill").mockReturnValue(true); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); status.readFile.mockResolvedValue("VmRSS:\t100 kB"); });

it("kills native memory growth and cleans up its monitor and pipes", async () => {
  vi.useFakeTimers(); const process = child();
  status.readFile.mockResolvedValue(`VmRSS:\t${MEDIA_LIMITS.decoderRssBytes / 1024 + 1} kB`);
  const pending = expect(rewriteMedia(new Uint8Array([1]))).rejects.toMatchObject({ code: "too_large", status: 413 });
  await vi.advanceTimersByTimeAsync(MEDIA_LIMITS.decoderPollMs); await pending;
  expect(process.kill).toHaveBeenCalledWith("SIGKILL");
  expect(process.stdin.destroyed).toBe(true);
  expect(process.stdout.destroyed).toBe(true);
  const calls = status.readFile.mock.calls.length;
  await vi.advanceTimersByTimeAsync(MEDIA_LIMITS.processingMs);
  expect(status.readFile).toHaveBeenCalledTimes(calls);
});
it("kills a stuck decoder after the processing deadline", async () => {
  vi.useFakeTimers(); const process = child();
  const pending = expect(rewriteMedia(new Uint8Array([1]))).rejects.toMatchObject({ code: "generic", status: 408 });
  await vi.advanceTimersByTimeAsync(MEDIA_LIMITS.processingMs); await pending;
  expect(process.kill).toHaveBeenCalledWith("SIGKILL");
});
it("handles native decoder crashes without propagating process signals", async () => {
  const process = child(), pending = expect(rewriteMedia(new Uint8Array([1]))).rejects.toMatchObject({ code: "generic" });
  process.emit("close", null, "SIGSEGV"); await pending;
});
it("bounds a misbehaving worker's output", async () => {
  const process = child(), pending = expect(rewriteMedia(new Uint8Array([1]))).rejects.toMatchObject({ code: "too_large" });
  process.stdout.write(Buffer.alloc(MEDIA_LIMITS.storedBytes + 9)); await pending;
  expect(process.kill).toHaveBeenCalledWith("SIGKILL");
});
it("times out a sender that never finishes and cancels its stream", async () => {
  vi.useFakeTimers(); const cancel = vi.fn();
  const request = new Request("http://localhost/media", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=a" }, body: new ReadableStream({ cancel }), duplex: "half" } as RequestInit);
  const pending = expect(readMediaForm(request)).rejects.toMatchObject({ code: "generic", status: 408 });
  await vi.advanceTimersByTimeAsync(MEDIA_LIMITS.receivingMs); await pending;
  expect(cancel).toHaveBeenCalled();
});
