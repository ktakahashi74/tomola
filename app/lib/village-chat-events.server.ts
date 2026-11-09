export const CHAT_CONNECTION_LIMIT = 4;
export const CHAT_PROCESS_LIMIT = 500;
export const CHAT_VILLAGE_LIMIT = 200;
export const CHAT_CONNECTION_MS = 10 * 60_000;
export const CHAT_HEARTBEAT_MS = 20_000;
type Connection = { villageId: string; userId: string; send(seq: number): void; close(): void };
const global = globalThis as typeof globalThis & { __tomolaChatConnections?: Set<Connection>; __tomolaChatSignals?: Map<string, { seq: number; timer: ReturnType<typeof setTimeout> }> };
const connections = global.__tomolaChatConnections ??= new Set<Connection>();

export function closeVillageChatConnections(villageId: string, userId?: string): void {
  for (const connection of connections) if (connection.villageId === villageId && (userId === undefined || connection.userId === userId)) connection.close();
}
export function closeMemberChatConnections(userId: string): void {
  for (const connection of connections) if (connection.userId === userId) connection.close();
}
const pending = global.__tomolaChatSignals ??= new Map<string, { seq: number; timer: ReturnType<typeof setTimeout> }>();
export const CHAT_SIGNAL_MS = 200;
export function stopVillageChat(): void {
  for (const connection of connections) connection.close();
  for (const value of pending.values()) clearTimeout(value.timer);
  pending.clear();
}
export function signalVillageChat(villageId: string, seq: number): void {
  const existing = pending.get(villageId);
  if (existing) { existing.seq = Math.max(existing.seq, seq); return; }
  const signal = { seq, timer: setTimeout(() => {
    pending.delete(villageId);
    for (const connection of connections) if (connection.villageId === villageId) connection.send(signal.seq);
  }, CHAT_SIGNAL_MS) };
  signal.timer.unref?.();
  pending.set(villageId, signal);
}

export function villageChatEventStream(villageId: string, userId: string, seq: number, signal: AbortSignal): Response {
  const headers = { "Cache-Control": "private, no-store, no-transform", "X-Accel-Buffering": "no", "Content-Type": "text/event-stream", "X-Robots-Tag": "noindex" };
  if (connections.size >= CHAT_PROCESS_LIMIT) {
    return new Response(null, { status: 503, headers: { ...headers, "Retry-After": "15" } });
  }
  if ([...connections].filter(c => c.userId === userId).length >= CHAT_CONNECTION_LIMIT || [...connections].filter(c => c.villageId === villageId).length >= CHAT_VILLAGE_LIMIT) return new Response(null, { status: 503, headers: { ...headers, "Retry-After": "15" } });
  let close = () => {};
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (text: string) => { if (!closed) { try { controller.enqueue(encoder.encode(text)); } catch { close(); } } };
      const heartbeat = setInterval(() => write(": heartbeat\n\n"), CHAT_HEARTBEAT_MS);
      const expiry = setTimeout(() => close(), CHAT_CONNECTION_MS);
      heartbeat.unref?.(); expiry.unref?.();
      const connection: Connection = { villageId, userId, send: n => write(`event: change\ndata: ${n}\n\n`), close: () => close() };
      close = () => {
        if (closed) return;
        closed = true; clearInterval(heartbeat); clearTimeout(expiry);
        signal.removeEventListener("abort", close); connections.delete(connection);
        try { controller.close(); } catch { /* Consumer already cancelled. */ }
      };
      connections.add(connection);
      if (connections.size === CHAT_PROCESS_LIMIT) console.warn("[chat-events] process connection limit reached");
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close(); else connection.send(seq);
    },
    cancel() { close(); },
  });
  return new Response(body, { headers });
}
