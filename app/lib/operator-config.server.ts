import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isCountryCode } from "./trial-consent";
import { operatorCopy, participationCopy, type PublicOperatorSettings } from "./operator-settings";

type Env = Record<string, string | undefined>;
const text = z.string().trim().min(1);
const localized = <T extends z.ZodType>(value: T) => z.object({ en: value, ja: value }).catchall(value);
const copyText = (allowed: string[] = [], required: string[] = []) => text.refine(value => {
  const tokens = [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
  return tokens.every(token => allowed.includes(token)) && required.every(token => tokens.filter(found => found === token).length === 1)
    && !/[{}]/.test(value.replace(/\{\w+\}/g, ""));
}, "Use only the documented placeholders, each required placeholder exactly once");
const schema = z.object({
  status: z.literal("configured"),
  name: localized(text),
  contactEmail: z.email(),
  privacyEmail: z.email(),
  copy: localized(z.object({
    aiRecipient: copyText(),
    stanceDisclosure: copyText(),
    stanceConsent: copyText(),
    trainingPolicy: copyText(),
    chatProvider: copyText(["privacy"], ["privacy"]),
    chatProviderChange: copyText(),
    termsLabel: copyText().nullable(),
    countryHelp: copyText().nullable(),
    adultError: copyText(["age"], ["age"]).nullable(),
    agreementLabel: copyText().nullable(),
    agreementError: copyText().nullable(),
    reviewTitle: copyText().nullable(),
    reviewHelp: copyText().nullable(),
    testSiteNotice: copyText().nullable(),
  }).strict()),
  participation: z.object({
    minimumAge: z.number().int().min(0).max(150),
    excludedResidenceCountries: z.array(text.refine(isCountryCode, "Expected an ISO 3166-1 alpha-2 country code")),
    requireTrialConsent: z.boolean(),
    trialConsentVersion: z.number().int().positive(),
    stanceConsentVersion: z.number().int().positive(),
    copy: localized(z.object({ countryExcluded: text, invitationRestriction: text, eligibilitySummary: text }).strict()),
  }).strict(),
}).strict();

export type OperatorConfig = PublicOperatorSettings & { documents: Record<string, Record<string, string>> };
const placeholders = /【[^】]*】|\{\{[^}]*\}\}|REPLACE_ME|Example Operator|(?:contact|privacy)@example\.org/i;
const documentKinds = ["terms", "privacy", "ai-policy", "principles-footer", "principles-rules-status", "principles-objections-contact"] as const;

function read(file: string): string {
  try { return fs.readFileSync(file, "utf8"); }
  catch { throw new Error(`Operator settings: missing or unreadable file ${file}`); }
}

// Validate the whole directory before returning any settings. Documents are
// cached with the settings for the lifetime of a server; restart after edits.
export function loadOperatorConfig(env: Env = process.env): OperatorConfig {
  const directory = env.TOMOLA_OPERATOR_DIR?.trim();
  if (!directory) throw new Error("TOMOLA_OPERATOR_DIR is required: set it to a complete operator settings directory");
  const file = path.resolve(directory, "operator.json");
  let raw: unknown;
  try { raw = JSON.parse(read(file)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("Operator settings: operator.json must contain valid JSON");
    throw error;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`Operator settings: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  if (placeholders.test(JSON.stringify(parsed.data))) throw new Error("Operator settings: replace all example names, addresses and placeholder values in operator.json");
  const documents: OperatorConfig["documents"] = {};
  for (const kind of documentKinds) {
    const required = kind === "ai-policy" ? ["en"] : ["en", "ja"];
    const folder = path.resolve(directory, kind);
    let editions: string[];
    try { editions = fs.readdirSync(folder).filter(name => /^[a-z]{2,3}(?:-[A-Za-z]+)?\.md$/.test(name)); }
    catch { throw new Error(`Operator settings: missing document directory ${kind}`); }
    const sources: Record<string, string> = {};
    for (const name of new Set([...editions, ...required.map(lang => `${lang}.md`)])) {
      const markdown = read(path.join(folder, name));
      if (!markdown.trim() || placeholders.test(markdown)) throw new Error(`Operator settings: ${kind}/${name} is empty or contains a placeholder`);
      if ((kind === "privacy" || kind === "terms") && !markdown.startsWith("# ")) throw new Error(`Operator settings: ${kind}/${name} must start with a Markdown title (# )`);
      if (kind === "privacy" || kind === "terms") {
        const sections = [...markdown.matchAll(/^## (\d+)\. /gm)].map(match => Number(match[1]));
        if (!sections.length || sections.some((number, index) => number !== index + 1) || (kind === "privacy" && !sections.includes(6))) {
          throw new Error(`Operator settings: ${kind}/${name} needs consecutive numbered sections (## 1. ...); privacy needs section 6 for contact links`);
        }
      }
      sources[name.slice(0, -3)] = markdown;
    }
    documents[kind] = sources;
  }
  const { status: _status, ...settings } = parsed.data;
  return { ...settings, documents };
}

let cached: { directory: string | undefined; config: OperatorConfig } | undefined;
export function operatorConfig(): OperatorConfig {
  const directory = process.env.TOMOLA_OPERATOR_DIR;
  if (!cached || cached.directory !== directory) cached = { directory, config: loadOperatorConfig() };
  return cached.config;
}

export function publicOperatorSettings(locale: string): PublicOperatorSettings {
  const config = operatorConfig();
  const { name, contactEmail, privacyEmail, participation } = config;
  return {
    name: { [locale]: name[locale] ?? name.en },
    contactEmail,
    privacyEmail,
    // The loader and document entry supply the banner only when enabled.
    // Do not duplicate its configured text in metadata on ordinary sites.
    copy: { [locale]: { ...operatorCopy(config, locale), testSiteNotice: null } },
    participation: { ...participation, copy: { [locale]: participationCopy(participation, locale) } },
  };
}

export function operatorDocument(kind: typeof documentKinds[number], locale: string): string {
  const editions = operatorConfig().documents[kind];
  return editions[locale] ?? editions.en;
}
