import { expect, it } from "vitest";
import { prehydrationBody } from "../app/lib/prehydration-input";

for (const navigation of ["reload", "back_forward"] as const) {
  it(`keeps newer server text on document ${navigation} when the browser restores an older value`, () => {
    expect(prehydrationBody({ value: "Older browser value", defaultValue: "Newer server text" }, navigation)).toBeUndefined();
  });
}
for (const navigation of ["navigate", undefined] as const) {
  it(`preserves early native input on ${navigation ?? "unavailable navigation timing"}`, () => {
    expect(prehydrationBody({ value: "Early member input", defaultValue: "Saved server text" }, navigation)).toBe("Early member input");
    expect(prehydrationBody({ value: "", defaultValue: "Saved server text" }, navigation)).toBe("");
    expect(prehydrationBody({ value: "Saved server text", defaultValue: "Saved server text" }, navigation)).toBeUndefined();
  });
}
