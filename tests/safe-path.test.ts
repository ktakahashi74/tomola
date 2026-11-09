import { describe, expect, it } from "vitest";
import { safeLocalPath } from "~/lib/display-lang.server";

describe("safeLocalPath", () => {
  it("keeps same-site paths with their query and fragment", () => {
    expect(safeLocalPath("/t/5?page=2&lang=en#c-9")).toBe("/t/5?page=2&lang=en#c-9");
    expect(safeLocalPath("/")).toBe("/");
    expect(safeLocalPath("/a/zh-Hant?page=3")).toBe("/a/zh-Hant?page=3");
    // "//" inside a query or fragment is not a path.
    expect(safeLocalPath("/ok?next=//evil.example#//x")).toBe("/ok?next=//evil.example#//x");
    // Return normalized ordinary paths when normalization is valid.
    expect(safeLocalPath("/a/./b/../c")).toBe("/a/c");
  });

  it("falls back to / for anything that could leave the site", () => {
    for (const bad of [
      "//evil.example/x",
      "https://evil.example",
      "javascript:alert(1)",
      "/\\evil.example",
      "/a\\b",
      "",
      null,
      undefined,
      "x/y",
      "/ok\r\nSet-Cookie: a=b",
      // Inputs that normalize to "//evil.example…".
      "/.//evil.example/x",
      "/%2e//evil.example",
      "/a/..//evil.example",
      "/./%2e//evil.example",
      "/\t/evil.example",
      "/a/%2E%2e//evil.example",
    ]) {
      expect(safeLocalPath(bad), String(bad)).toBe("/");
    }
  });

  it("never returns a value that starts with two slashes", () => {
    for (const raw of ["/.//x", "/..//x", "/a/..//x", "/%2e//x", "/%2e%2e//x", "/a/%2e%2e//x", "/././/x"]) {
      expect(safeLocalPath(raw).startsWith("//"), raw).toBe(false);
    }
  });
});
