import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MEDIA_LIMITS, MediaError } from "~/lib/media";

let active = 0;
export async function withMediaSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MEDIA_LIMITS.concurrent) throw new MediaError("generic", 503);
  active++;
  try { return await work(); } finally { active--; }
}

// Admission for the receiving stage, taken before any body bytes are read. Bounds aggregate buffered request memory
// (roughly receiving * requestBytes, and briefly a few times that while a finished body is copied out) globally and per member,
// independently of the decoder slots. Refusals are not charged.
let receiving = 0;
const receivingByMember = new Map<string, number>();
export async function withReceiveSlot<T>(memberId: string, work: () => Promise<T>): Promise<T> {
  const mine = receivingByMember.get(memberId) ?? 0;
  if (receiving >= MEDIA_LIMITS.receiving || mine >= MEDIA_LIMITS.receivingPerMember) throw new MediaError("generic", 503);
  receiving++; receivingByMember.set(memberId, mine + 1);
  try { return await work(); }
  finally {
    receiving--;
    const left = (receivingByMember.get(memberId) ?? 1) - 1;
    if (left > 0) receivingByMember.set(memberId, left); else receivingByMember.delete(memberId);
  }
}

export async function readMediaForm(request: Request): Promise<File> {
  const announced = request.headers.get("content-length");
  if (announced && (!/^\d+$/.test(announced) || Number(announced) > MEDIA_LIMITS.requestBytes)) throw new MediaError("too_large", 413);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;") || !request.body) throw new MediaError("type");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MEDIA_LIMITS.requestBytes) throw new MediaError("too_large", 413);
          chunks.push(part.value);
        }
        return Buffer.concat(chunks);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MediaError("generic", 408)), MEDIA_LIMITS.receivingMs); }),
    ]);
    const form = await new Request(request.url, { method: "POST", headers: { "content-type": request.headers.get("content-type")! }, body: bytes }).formData();
    const all = [...form.entries()];
    if (all.length !== 1 || all[0][0] !== "image" || typeof all[0][1] === "string") throw new MediaError("generic");
    const file = all[0][1];
    if (file.size > MEDIA_LIMITS.inputBytes) throw new MediaError("too_large", 413);
    if (!file.size) throw new MediaError("generic");
    return file;
  } catch (error) { throw error instanceof MediaError ? error : new MediaError("generic"); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

export function rewriteMedia(bytes: Uint8Array, opts: { avatar?: boolean } = {}): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (bytes.byteLength > MEDIA_LIMITS.inputBytes) return Promise.reject(new MediaError("too_large", 413));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=64", path.resolve("server/media-worker.mjs"), ...(opts.avatar ? ["avatar"] : [])], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV } });
    const chunks: Buffer[] = [];
    let size = 0, closed = false, failure: MediaError | undefined, checking = false;
    const stop = (error: MediaError) => {
      if (closed || failure) return;
      failure = error;
      clearTimeout(timer); clearInterval(monitor);
      chunks.length = 0;
      child.stdin.destroy();
      if (process.platform !== "win32" && child.pid) {
        // The child owns a fresh process group; terminate descendants that may
        // otherwise retain the pipes after a decoder failure.
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
      child.kill("SIGKILL");
      // Settle only after close, so the caller retains its decoder slot until
      // the process is reaped and all pipes have closed.
    };
    const timer = setTimeout(() => stop(new MediaError("generic", 408)), MEDIA_LIMITS.processingMs);
    // V8's heap limit does not cover libvips/native buffers. On Linux, watch
    // the child's resident set from the parent, even while its event loop is
    // blocked. This is a sampled guard, not an OS allocation limit.
    const monitor = process.platform === "linux" ? setInterval(async () => {
      if (closed || failure || checking || !child.pid) return;
      checking = true;
      try {
        const status = await readFile(`/proc/${child.pid}/status`, "utf8");
        const rss = /\bVmRSS:\s+(\d+)\s+kB/.exec(status);
        if (!closed && !failure && rss && Number(rss[1]) * 1024 > MEDIA_LIMITS.decoderRssBytes) stop(new MediaError("too_large", 413));
      } catch (error) {
        // A disappearing PID belongs to close; other failures cannot silently
        // disable the native-memory guard.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") stop(new MediaError("generic"));
      } finally { checking = false; }
    }, MEDIA_LIMITS.decoderPollMs) : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      if (closed || failure) return;
      size += chunk.length;
      if (size > MEDIA_LIMITS.storedBytes + 8) stop(new MediaError("too_large", 413));
      else chunks.push(chunk);
    });
    child.on("error", () => stop(new MediaError("generic")));
    child.stdin.on("error", () => {});
    child.once("close", code => {
      if (closed) return;
      closed = true;
      clearTimeout(timer); clearInterval(monitor);
      child.stdin.destroy(); child.stdout.destroy();
      if (!failure && (code !== 0 || size <= 8)) failure = new MediaError(code === 2 ? "type" : code === 3 ? "too_large" : "generic", code === 3 ? 413 : 400);
      if (failure) { reject(failure); return; }
      const output = Buffer.concat(chunks), width = output.readUInt32BE(0), height = output.readUInt32BE(4);
      chunks.length = 0;
      if (!width || !height || width > MEDIA_LIMITS.edge || height > MEDIA_LIMITS.edge) reject(new MediaError("generic"));
      else resolve({ bytes: output.subarray(8), width, height });
    });
    child.stdin.end(bytes);
  });
}
