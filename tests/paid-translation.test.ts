import { expect, it } from "vitest";
import { translationCallKey } from "~/lib/jobs/paid-translation.server";
it("identifies a paid request by values rather than JSON object ordering or cancellation objects", () => {
  const engine = { id: "claude" as const, model: "fixture" };
  const a = translationCallKey(engine, { text: "source", from: "en", to: "ja", signal: new AbortController().signal }, "translate", "primary");
  expect(translationCallKey(engine, { to: "ja", from: "en", text: "source" }, "translate", "primary")).toBe(a);
  expect(translationCallKey(engine, { to: "ja", from: "en", text: "changed" }, "translate", "primary")).not.toBe(a);
});
