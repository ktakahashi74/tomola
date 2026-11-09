import { expect, it } from "vitest";
import { originalLanguagePath } from "~/lib/navigation";

it("carries stream choices between original languages while resetting pagination and transient status", () => {
  const search = "?order=activity&asks=1&long=1&lang=ja&page=2&posted=7&peek=8&_routes=routes%2Fhome";
  expect(originalLanguagePath(search, "en")).toBe("/a/en?order=activity&asks=1&long=1&lang=ja");
  expect(originalLanguagePath(search, null)).toBe("/?order=activity&asks=1&long=1&lang=ja");
});
it("keeps absent choices absent and preserves encoded query values", () => {
  expect(originalLanguagePath("?page=3", "ja")).toBe("/a/ja");
  expect(originalLanguagePath("?lang=zh-Hant&order=activity", null)).toBe("/?lang=zh-Hant&order=activity");
});
