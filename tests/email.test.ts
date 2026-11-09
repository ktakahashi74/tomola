import { describe, expect, it } from "vitest";
import { parseEmail } from "~/lib/email";

describe("parseEmail", () => {
  it("rejects addresses that Better Auth would reject", () => {
    expect(parseEmail("taro@gmail")).toBeNull();
    expect(parseEmail("user@localhost")).toBeNull();
    expect(parseEmail("a!b@example.com")).toBeNull();
    expect(parseEmail("")).toBeNull();
    expect(parseEmail("no-at-sign")).toBeNull();
  });

  it("normalizes a valid address", () => {
    expect(parseEmail("Alice@Example.com")).toBe("alice@example.com");
    expect(parseEmail("  Alice@Example.com ")).toBe("alice@example.com");
  });
});
