import { expect, it } from "vitest";
import { getChatReadingPosition, hasChatReadingPosition, rememberChatReadingPosition } from "~/lib/chat-reading-positions";

it("retains only fifty recent chat history entries and refreshes an existing entry", () => {
  for (let i = 0; i < 50; i++) rememberChatReadingPosition(String(i), { id: `chat-${i}`, top: i, seq: i });
  rememberChatReadingPosition("0", { id: "chat-updated", top: 1, seq: 99 });
  rememberChatReadingPosition("50");
  expect(hasChatReadingPosition("1")).toBe(false);
  expect(getChatReadingPosition("0")).toEqual({ id: "chat-updated", top: 1, seq: 99 });
  expect(hasChatReadingPosition("50")).toBe(true);
  for (let i = 51; i < 101; i++) rememberChatReadingPosition(String(i));
  expect(Array.from({ length: 101 }, (_, i) => hasChatReadingPosition(String(i))).filter(Boolean)).toHaveLength(50);
  expect(getChatReadingPosition("0")).toBeUndefined();
});
