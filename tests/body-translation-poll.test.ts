import { expect, it } from "vitest";
import { BODY_TRANSLATION_WAIT_MS, bodyTranslationPollDelay } from "~/lib/body-translation-poll";
import { MAX_TRANSLATION_TIMEOUT_MS, translationTimeoutMs } from "~/lib/llm/request-timeout";

it("backs off from three seconds to a maximum of thirty seconds", () => {
  expect(Array.from({ length: 6 }, (_, round) => bodyTranslationPollDelay(round, BODY_TRANSLATION_WAIT_MS)))
    .toEqual([3000, 6000, 12_000, 24_000, 30_000, 30_000]);
});

it("allows a minute after the server cap and never schedules past the deadline", () => {
  expect(translationTimeoutMs(64_000)).toBe(MAX_TRANSLATION_TIMEOUT_MS);
  expect(BODY_TRANSLATION_WAIT_MS - MAX_TRANSLATION_TIMEOUT_MS).toBe(60_000);
  expect(bodyTranslationPollDelay(10, 1_200)).toBe(1200);
  expect(bodyTranslationPollDelay(10, -1)).toBe(0);
});
