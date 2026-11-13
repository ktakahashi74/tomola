import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadOperatorConfig, operatorDocument, publicOperatorSettings } from "~/lib/operator-config.server";
import { hasStanceConsent, needsTrialConsent, validateTrialInput } from "~/lib/trial-consent";
import { operatorCopy, formatOperatorCopy } from "~/lib/operator-settings";
import { assertStartupConfig } from "~/lib/startup-checks.server";

const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function copy() {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "operator-test-"));
  temporary.push(directory);
  fs.cpSync("tests/fixtures/operator", directory, { recursive: true });
  const file = path.join(directory, "operator.json");
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  return { directory, file, settings, load: () => loadOperatorConfig({ TOMOLA_OPERATOR_DIR: directory }), save: () => fs.writeFileSync(file, JSON.stringify(settings)) };
}

it("requires an explicit directory and readable valid JSON", () => {
  expect(() => loadOperatorConfig({})).toThrow("TOMOLA_OPERATOR_DIR is required");
  const fixture = copy();
  fs.unlinkSync(fixture.file);
  expect(fixture.load).toThrow("operator.json");
  fs.writeFileSync(fixture.file, "{");
  expect(fixture.load).toThrow("valid JSON");
});

it("requires strict AI-use settings, validates history references and accepts an empty public example", () => {
  const fixture = copy();
  const original = structuredClone(fixture.settings.aiUse);
  delete fixture.settings.aiUse; fixture.save();
  expect(fixture.load).toThrow("aiUse");
  fixture.settings.aiUse = JSON.parse(fs.readFileSync("deploy/operator/tomola.org/ai-use.example.json", "utf8")).aiUse;
  fixture.save();
  expect(fixture.load().aiUse).toEqual({ history: [], humanReview: null, objectionsUrl: null });
  for (const invalid of [
    { ...original, apiKey: "fictional-key" },
    { ...original, history: [{ ...original.history[0], purpose: "unknown-use" }] },
    { ...original, history: [{ ...original.history[0], date: "2026-02-30" }] },
    { ...original, history: [{ ...original.history[0], toModel: "https://example.net/model" }] },
    { ...original, history: [{ ...original.history[0], reason: { en: "Missing Japanese" } }] },
    { ...original, history: [{ ...original.history[0], price: 10 }] },
    { ...original, objectionsUrl: "javascript:alert(1)" },
    { ...original, objectionsUrl: "//example.net/post" },
    { ...original, objectionsUrl: "https://fictional:password@example.net/post" },
    { ...original, history: [{ ...original.history[0], evidenceUrl: "https://fictional:password@example.net/compare" }] },
  ]) {
    fixture.settings.aiUse = invalid; fixture.save();
    expect(fixture.load).toThrow();
  }
});

it.each(["minimumAge", "excludedResidenceCountries", "requireTrialConsent", "trialConsentVersion", "stanceConsentVersion"])("rejects a missing participation.%s instead of relaxing eligibility", field => {
  const fixture = copy();
  delete fixture.settings.participation[field]; fixture.save();
  expect(fixture.load).toThrow(`participation.${field}`);
});

it("rejects invalid types, country codes and unknown fields", () => {
  const fixture = copy();
  Object.assign(fixture.settings.participation, { minimumAge: "18", excludedResidenceCountries: ["cn"], requireTrialConsent: "false", stanceConsentVersion: 0 });
  fixture.settings.ignoredSetting = true; fixture.save();
  for (const field of ["minimumAge", "excludedResidenceCountries", "requireTrialConsent", "stanceConsentVersion", "ignoredSetting"]) expect(fixture.load).toThrow(field);
});

it("rejects the example and leftover placeholders in settings or any document edition", () => {
  expect(() => loadOperatorConfig({ TOMOLA_OPERATOR_DIR: path.resolve("deploy/operator.example") })).toThrow("status");
  const fixture = copy();
  fixture.settings.name.en = "Example Operator"; fixture.save();
  expect(fixture.load).toThrow("placeholder");
  fixture.settings.name.en = "A community"; fixture.save();
  fs.writeFileSync(path.join(fixture.directory, "principles-footer", "fr.md"), "【fill in】");
  expect(fixture.load).toThrow("principles-footer/fr.md");
});

it("requires complete notices and the AI policy before returning any configuration", () => {
  for (const file of ["privacy/ja.md", "terms/en.md", "ai-policy/en.md", "principles-footer/en.md"]) {
    const fixture = copy();
    fs.unlinkSync(path.join(fixture.directory, file));
    expect(fixture.load).toThrow(file);
  }
});

it.each(["principles-rules-status", "principles-objections-contact"] as const)("validates every %s edition at loading and startup, with English fallback", kind => {
  const fixture = copy();
  vi.stubEnv("TOMOLA_OPERATOR_DIR", fixture.directory);
  const english = fs.readFileSync(path.join(fixture.directory, kind, "en.md"), "utf8");
  expect(operatorDocument(kind, "fr")).toBe(english);
  expect(operatorDocument(kind, "ja")).toBe(fs.readFileSync(path.join(fixture.directory, kind, "ja.md"), "utf8"));
  fs.writeFileSync(path.join(fixture.directory, kind, "fr.md"), "French operator information.");
  expect(fixture.load().documents[kind].fr).toBe("French operator information.");
  for (const locale of ["en", "ja", "fr"]) {
    const file = path.join(fixture.directory, kind, `${locale}.md`);
    const original = fs.readFileSync(file, "utf8");
    for (const invalid of ["", " \n", "REPLACE_ME", "【fill in】"]) {
      fs.writeFileSync(file, invalid);
      expect(fixture.load).toThrow(`${kind}/${locale}.md`);
      expect(() => assertStartupConfig({ NODE_ENV: "development", TOMOLA_OPERATOR_DIR: fixture.directory })).toThrow(`${kind}/${locale}.md`);
    }
    fs.writeFileSync(file, original);
    if (locale !== "fr") {
      fs.unlinkSync(file);
      expect(fixture.load).toThrow(`${kind}/${locale}.md`);
      expect(() => assertStartupConfig({ NODE_ENV: "development", TOMOLA_OPERATOR_DIR: fixture.directory })).toThrow(`${kind}/${locale}.md`);
      fs.writeFileSync(file, original);
    }
  }
  fs.rmSync(path.join(fixture.directory, kind), { recursive: true });
  expect(fixture.load).toThrow(`missing document directory ${kind}`);
});

it("rejects participation copy left over from the example after other settings are configured", () => {
  const fixture = copy();
  const example = JSON.parse(fs.readFileSync("deploy/operator.example/operator.json", "utf8"));
  fixture.settings.participation.copy = example.participation.copy;
  fixture.save();
  expect(fixture.load).toThrow("placeholder");
});

it.each(["en", "ja", "fr"])("sends only the %s interface copy and name, with English fallback for missing editions", locale => {
  const config = loadOperatorConfig();
  const settings = publicOperatorSettings(locale);
  expect(settings.name).toEqual({ [locale]: config.name[locale] ?? config.name.en });
  expect(settings.participation.copy).toEqual({ [locale]: config.participation.copy[locale] ?? config.participation.copy.en });
  expect(settings.copy).toEqual({ [locale]: operatorCopy(config, locale) });
  expect(settings.participation.excludedResidenceCountries).toEqual(config.participation.excludedResidenceCountries);
  expect(settings).not.toHaveProperty("documents");
});

it.each(["en", "ja"])("rejects every missing or placeholder operator copy field at loading and startup in %s", locale => {
  const fixture = copy();
  const original = { ...fixture.settings.copy[locale] };
  for (const field of Object.keys(original)) {
    delete fixture.settings.copy[locale][field]; fixture.save();
    expect(fixture.load, field).toThrow(`copy.${locale}.${field}`);
    expect(() => assertStartupConfig({ NODE_ENV: "development", TOMOLA_OPERATOR_DIR: fixture.directory }), field).toThrow(`copy.${locale}.${field}`);
    fixture.settings.copy[locale] = { ...original, [field]: `REPLACE_ME: ${original[field] ?? (field === "adultError" ? "site wording {age}" : "site wording")}` }; fixture.save();
    expect(fixture.load, field).toThrow("placeholder");
    expect(() => assertStartupConfig({ NODE_ENV: "development", TOMOLA_OPERATOR_DIR: fixture.directory }), field).toThrow("placeholder");
    fixture.settings.copy[locale] = { ...original };
  }
});

it("requires complete language editions and validates privacy and age interpolation", () => {
  const fixture = copy();
  for (const field of ["aiRecipient", "stanceDisclosure", "stanceConsent", "trainingPolicy", "chatProvider", "chatProviderChange"]) {
    const original = fixture.settings.copy.en[field];
    fixture.settings.copy.en[field] = null; fixture.save();
    expect(fixture.load, field).toThrow(`copy.en.${field}`);
    fixture.settings.copy.en[field] = original;
  }
  for (const value of ["Missing link", "{privacy} and {privacy}", "{privacy} {other}"]) {
    fixture.settings.copy.en.chatProvider = value; fixture.save();
    expect(fixture.load).toThrow("copy.en.chatProvider");
  }
  fixture.settings.copy.en.chatProvider = "See {privacy}.";
  fixture.settings.copy.en.adultError = "Confirm your age."; fixture.save();
  expect(fixture.load).toThrow("copy.en.adultError");
  fixture.settings.copy.en.adultError = "You must be {age} or older.";
  fixture.settings.copy.fr = { chatProvider: "See {privacy}." }; fixture.save();
  expect(fixture.load).toThrow("copy.fr");
});

it("selects one complete locale with English fallback and formats values without recursive substitution", () => {
  const config = copy().load();
  expect(operatorCopy(config, "ja")).toBe(config.copy.ja);
  expect(operatorCopy(config, "fr")).toBe(config.copy.en);
  expect(formatOperatorCopy("{privacy}: {age}", { privacy: "$& {age}", age: 23 })).toBe("$& {age}: 23");
});

it("keeps a configured test banner out of public settings in both site stages", () => {
  const fixture = copy();
  fixture.settings.copy.en.testSiteNotice = "A site-specific test banner."; fixture.save();
  vi.stubEnv("TOMOLA_OPERATOR_DIR", fixture.directory);
  for (const stage of ["", "test"]) {
    vi.stubEnv("TOMOLA_SITE_STAGE", stage);
    expect(publicOperatorSettings("en").copy.en.testSiteNotice).toBeNull();
    expect(fixture.load().copy.en.testSiteNotice).toBe(fixture.settings.copy.en.testSiteNotice);
  }
});

it("accepts configured documents and explicit zero-age, no-exclusion and no-agreement policies", () => {
  const fixture = copy();
  Object.assign(fixture.settings.participation, { minimumAge: 0, excludedResidenceCountries: [], requireTrialConsent: false }); fixture.save();
  const config = fixture.load();
  expect(config.documents.privacy.ja).toBe(fs.readFileSync(path.join(fixture.directory, "privacy/ja.md"), "utf8"));
  expect(validateTrialInput({ residenceCountry: "CN", adult: false, agree: false, version: config.participation.trialConsentVersion }, config.participation)).toBeNull();
});

it("uses the configured eligibility and independent versions without coupling age or country restrictions to agreement", () => {
  const policy = { ...copy().load().participation, minimumAge: 21, excludedResidenceCountries: ["JP"], requireTrialConsent: false, trialConsentVersion: 8, stanceConsentVersion: 6 };
  const input = { residenceCountry: "US", adult: true, agree: false, version: policy.trialConsentVersion };
  expect(validateTrialInput(input, policy)).toBeNull();
  expect(validateTrialInput({ ...input, residenceCountry: "JP" }, policy)).toBe("country_excluded");
  expect(validateTrialInput({ ...input, adult: false }, policy)).toBe("adult_required");
  expect(validateTrialInput({ ...input, version: 7 }, policy)).toBe("trial_consent_required");
  const accepted = { residenceCountry: "US", adultConfirmedAt: new Date(), trialConsentVersion: 8, trialConsentAt: new Date() };
  expect(needsTrialConsent(accepted, policy)).toBe(false);
  expect(needsTrialConsent({ ...accepted, trialConsentVersion: 7 }, policy)).toBe(true);
  expect(hasStanceConsent({ stanceConsentVersion: 6, stanceConsentAt: new Date() }, policy)).toBe(true);
  expect(hasStanceConsent({ stanceConsentVersion: 5, stanceConsentAt: new Date() }, policy)).toBe(false);
});
