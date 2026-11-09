import { describe, expect, it } from "vitest";
import { homeTrialEnabled } from "~/lib/home-trial.server";

describe("home trial navigation", () => {
  const trial = { TOMOLA_HOME_TRIAL: "1", TOMOLA_ALLOW_FAKE_ENGINES: "1", TRANSLATION_PRIMARY: "fake", EMBEDDING_ENGINE: "fake" };
  it("is absent from ordinary deployments", () => {
    expect(homeTrialEnabled({})).toBe(false);
    expect(homeTrialEnabled({ ...trial, TOMOLA_HOME_TRIAL: "0" })).toBe(false);
    expect(homeTrialEnabled(trial)).toBe(true);
  });
  it("refuses to expose the trial inbox with real engines or model credentials", () => {
    for (const override of [{ TOMOLA_ALLOW_FAKE_ENGINES: "0" }, { TRANSLATION_PRIMARY: "gemini" }, { EMBEDDING_ENGINE: "gemini" }, { GEMINI_API_KEY: "test-sentinel" }, { ANTHROPIC_API_KEY: "test-sentinel" }]) {
      expect(() => homeTrialEnabled({ ...trial, ...override })).toThrow("TOMOLA_HOME_TRIAL requires");
    }
  });
});
