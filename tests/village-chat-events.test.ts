import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import compression from "compression";
import http from "node:http";
import { CHAT_CONNECTION_MS, CHAT_HEARTBEAT_MS, closeVillageChatConnections, signalVillageChat, stopVillageChat, villageChatEventStream } from "~/lib/village-chat-events.server";

afterEach(() => { stopVillageChat(); vi.useRealTimers(); vi.restoreAllMocks(); });
const open = (village = "v", user = "u") => villageChatEventStream(village, user, 3, new AbortController().signal);
it("caps each village independently and reclaims a cancelled village slot", async () => {
  const responses = Array.from({ length: 200 }, (_, i) => open("crowded", `member-${i}`));
  expect(responses.every(response => response.status === 200)).toBe(true);
  expect(open("crowded", "extra").status).toBe(503);
  expect(open("other", "extra").status).toBe(200);
  await responses[0].body!.cancel();
  expect(open("crowded", "replacement").status).toBe(200);
});
it("logs process-wide saturation without logging member identities", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (let i = 0; i < 500; i++) expect(open(`v-${i}`, `member-${i}`).status).toBe(200);
  expect(open("overflow", "private-member").status).toBe(503);
  expect(warn).toHaveBeenCalled();
  expect(warn.mock.calls.flat().join(" ")).not.toContain("private-member");
});
it("coalesces source and translation signals into the highest cursor per village", async () => {
  vi.useFakeTimers();
  const reader = open().body!.getReader(); await reader.read();
  signalVillageChat("v", 8); signalVillageChat("v", 12); signalVillageChat("v", 10);
  let received = false;
  const next = reader.read().then(value => { received = true; return value; });
  await vi.advanceTimersByTimeAsync(99); expect(received).toBe(false);
  await vi.advanceTimersByTimeAsync(201);
  expect(new TextDecoder().decode((await next).value)).toBe("event: change\ndata: 12\n\n");
});
it("sends a sequence immediately, heartbeats, and expires the connection", async () => {
  vi.useFakeTimers(); const reader = open().body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: change\ndata: 3\n\n");
  await vi.advanceTimersByTimeAsync(CHAT_HEARTBEAT_MS);
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
  await vi.advanceTimersByTimeAsync(CHAT_CONNECTION_MS);
  while (!(await reader.read()).done) { /* Drain bounded queued heartbeats. */ }
});
it("caps connections by member and process and frees slots on cancel", async () => {
  const responses = Array.from({ length: 4 }, () => open()); expect(open().status).toBe(503);
  await responses[0].body!.cancel(); expect(open().status).toBe(200);
  stopVillageChat();
  for (let i = 0; i < 500; i++) expect(open(`v${Math.floor(i / 200)}`, `u${i}`).status).toBe(200);
  expect(open("other", "other").status).toBe(503);
});
it("keeps the global registry across module reloads and closes only matching recipients", async () => {
  vi.useFakeTimers();
  const a = open("one", "a").body!.getReader(), b = open("one", "b").body!.getReader(), c = open("two", "a").body!.getReader();
  await a.read(); await b.read(); await c.read();
  vi.resetModules(); const reloaded = await import("~/lib/village-chat-events.server");
  reloaded.signalVillageChat("one", 4); await vi.advanceTimersByTimeAsync(200); expect(new TextDecoder().decode((await a.read()).value)).toContain("data: 4"); await b.read();
  reloaded.closeVillageChatConnections("one", "a"); expect((await a.read()).done).toBe(true);
  reloaded.closeVillageChatConnections("one"); expect((await b.read()).done).toBe(true);
  signalVillageChat("two", 5); await vi.advanceTimersByTimeAsync(200); expect(new TextDecoder().decode((await c.read()).value)).toContain("data: 5");
  reloaded.stopVillageChat(); expect((await c.read()).done).toBe(true);
});
it("streams the first event before response completion through compression", async () => {
  const app = express(); app.use(compression());
  const controller = new AbortController();
  app.get("/events", async (_request, response) => {
    const result = villageChatEventStream("compression", "reader", 7, controller.signal);
    result.headers.forEach((value, key) => response.setHeader(key, value));
    const reader = result.body!.getReader();
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; response.write(chunk.value); }
    response.end();
  });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address() as { port: number };
  try {
    const chunk = await new Promise<string>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${address.port}/events`, { headers: { "Accept-Encoding": "gzip" } }, response => {
        expect(response.headers["cache-control"]).toBe("private, no-store, no-transform"); expect(response.headers["content-encoding"]).toBeUndefined();
        response.once("data", data => { resolve(data.toString()); request.destroy(); });
        response.once("end", () => reject(new Error("Ended before first chunk")));
      });
      request.setTimeout(2000, () => { request.destroy(); reject(new Error("Buffered event")); }); request.on("error", reject);
    });
    expect(chunk).toContain("data: 7");
  } finally { controller.abort(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
