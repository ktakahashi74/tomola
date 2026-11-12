import { shellLabels } from "~/lib/shell-labels.server";
import { SHELL_LABEL_KEYS } from "~/lib/shell-labels";
import { footerNotices } from "~/lib/notices.server";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createElement } from "react";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewLangs, assertEnabledLangsConfigured, assertEnabledLangsReviewed } from "~/lib/enabled-langs.server";
import { computeReviewCounts, parseReviewCounts } from "~/lib/i18n/review-counts";
import { OPERATOR_ONLY_KEYS } from "~/lib/i18n/operator-keys";
import { initialHashes } from "~/lib/i18n/source-hashes";
import { markVerified } from "~/lib/i18n/verification";
import { SiteFooter } from "~/components/site-footer";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { renderInRouter } from "./helpers/render-in-router";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const clean = { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 };
const env = { NODE_ENV: "production", ENABLED_LANGS: "ja,en,fr", PREVIEW_LANGS: "fr" };
afterEach(() => setTestLocale("en"));

describe("preview configuration and release gate", () => {
  it("parses case, whitespace and duplicates; absent or blank means no previews", () => {
    expect(previewLangs({ ENABLED_LANGS: "fr,zh-Hant", PREVIEW_LANGS: " FR,zh-hant,fr, " })).toEqual(["fr", "zh-Hant"]);
    expect(previewLangs({})).toEqual([]);
    expect(previewLangs({ PREVIEW_LANGS: " " })).toEqual([]);
  });
  it.each(["ja", "en", "de", "xx", ",", "fr,ja"])("refuses %s at startup in every environment", PREVIEW_LANGS => {
    for (const NODE_ENV of ["production", "development", "test"]) expect(() => assertEnabledLangsConfigured({ ...env, NODE_ENV, PREVIEW_LANGS })).toThrow(/PREVIEW_LANGS/);
  });
  it("permits unchecked public translations only with an explicit preview", () => {
    const counts = { ja: clean, en: clean, fr: { ...clean, unverified: 30, unverifiedPublic: 10 } };
    expect(() => assertEnabledLangsReviewed(env, counts)).not.toThrow();
    expect(() => assertEnabledLangsReviewed({ ...env, PREVIEW_LANGS: "" }, counts)).toThrow("10 unchecked public");
    expect(() => assertEnabledLangsReviewed({ ...env, PREVIEW_LANGS: "" }, { ...counts, fr: { ...counts.fr, unverifiedPublic: 0 } })).not.toThrow();
    expect(() => assertEnabledLangsReviewed(env, { ...counts, fr: { ...counts.fr, missing: 1 } })).toThrow("1 missing");
    for (const field of ["missing", "stale"] as const) expect(() => assertEnabledLangsReviewed(env, { ...counts, fr: { ...counts.fr, [field]: 1 } })).toThrow(field);
    expect(parseReviewCounts({ fr: { ...clean, unverifiedPublic: 1 } })).toBeNull();
    expect(parseReviewCounts({ fr: { unverified: 0, missing: 0, stale: 0 } })).toBeNull();
  });
});

it("the operator-only set matches actual screen uses and excludes shared or moderator messages", () => {
  const routes = new Set(["usage", "metrics", "observation", "invitations", "roles"].map(name => `app/routes/admin-${name}.tsx`));
  routes.add("app/components/quality-metrics.tsx");
  routes.add("app/components/reading-metrics.tsx");
  const links = new Set(["nav_usage", "nav_metrics", "nav_observation", "nav_invitations", "nav_roles"]);
  const admin = new Set<string>(); const other = new Set<string>();
  for (const file of fs.readdirSync("app", { recursive: true }).map(String).filter(file => /\.tsx?$/.test(file) && !file.startsWith("paraglide/"))) {
    const name = `app/${file}`;
    const ast = ts.createSourceFile(name, fs.readFileSync(name, "utf8"), ts.ScriptTarget.Latest, true);
    const importsMessages = ast.statements.some(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "~/paraglide/messages.js");
    if (!importsMessages) continue;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "m") (routes.has(name) ? admin : other).add(node.name.text);
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "m") {
        if (name !== "app/lib/shell-labels.server.ts") throw new Error(`Computed message key requires an explicit use analysis: ${name}`);
        for (const key of SHELL_LABEL_KEYS) other.add(key);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const expected = new Set([...admin].filter(key => !other.has(key)).concat([...links]));
  expect([...OPERATOR_ONLY_KEYS].sort()).toEqual([...expected].sort());
  expect(OPERATOR_ONLY_KEYS.has("stance_agree")).toBe(false);
  expect(OPERATOR_ONLY_KEYS.has("mod_heading")).toBe(false);
  expect(OPERATOR_ONLY_KEYS.has("quality_eval_title")).toBe(true);
  expect(OPERATOR_ONLY_KEYS.has("quality_eval_config_changed")).toBe(true);
  expect(OPERATOR_ONLY_KEYS.has("metrics_col_rate")).toBe(false);
  expect(OPERATOR_ONLY_KEYS.has("metrics_unobserved")).toBe(true);
});

it("counts both review totals and lets the CLI pass when only operator strings are unchecked", () => {
  const source = { $schema: "s", nav_usage: "Usage", field_body: "Body" };
  const files = { en: source, ja: source, fr: { ...source, nav_usage: "Utilisation", field_body: "Texte" } };
  const hashes = initialHashes(source, files);
  const verified = markVerified({}, "fr", source, files.fr, ["field_body"]).verified;
  const counts = computeReviewCounts(source, files, hashes, verified, {});
  expect(counts.fr).toMatchObject({ unverified: 1, unverifiedPublic: 0 });
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "i18n-preview-"));
  try {
    for (const lang of ["ja", "en", "fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"]) fs.writeFileSync(path.join(dir, `${lang}.json`), JSON.stringify(files[lang as keyof typeof files] ?? source));
    const allFiles = Object.fromEntries(["ja", "en", "fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"].map(lang => [lang, files[lang as keyof typeof files] ?? source]));
    fs.writeFileSync(path.join(dir, ".source-hashes.json"), JSON.stringify(initialHashes(source, allFiles)));
    fs.writeFileSync(path.join(dir, ".verified.json"), JSON.stringify(verified));
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/i18n-translate.ts", "--check", "--require-verified", "--lang", "fr"], { env: { ...process.env, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", I18N_MESSAGES_DIR: dir }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("fr 1");
    expect(result.stdout).toContain("unverified excluding operator-only strings: fr 0");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("shows the notice on the login footer only for the current preview locale", async () => {
  setTestLocale("fr");
  const render = (langs: readonly ("fr" | "de")[]) => renderInRouter(() => createElement(SiteFooter, { labels: shellLabels(), sourceUrl: null, ...footerNotices("fr", langs) }), "/login");
  expect(await render(["fr"])).toContain('role="note"');
  expect(await render([])).not.toContain('role="note"');
  expect(await render(["de"])).not.toContain('role="note"');
});
