import fs from "node:fs";
import { createHash } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { setTestMessages } from "./stubs/paraglide-messages";
import { jsonMessages } from "./helpers/messages-json";
import { computeReviewCounts } from "~/lib/i18n/review-counts";
import { checkStale, initialHashes } from "~/lib/i18n/source-hashes";
import { assertEnabledLangsReviewed } from "~/lib/enabled-langs.server";
import { villageName } from "~/lib/village-name";
import { localizedLanguageLabel } from "~/lib/language-label";
import { m } from "~/paraglide/messages.js";
import { LANGS } from "~/lib/languages";
import { translationSystemPrompt, PROMPT_VERSION, CHAT_PROMPT_VERSION } from "~/lib/llm/prompt.server";

beforeAll(() => setTestMessages(jsonMessages()));
afterAll(() => setTestMessages());

it("tracks the manually written Japanese reference against English without calling it unverified", () => {
  const source = { a: "Save" }, files = { en: source, ja: { a: "保存" } };
  const hashes = initialHashes(source, files);
  expect(checkStale(source, files, hashes)).toEqual([]);
  const changed = { a: "Save changes" };
  expect(checkStale(changed, files, hashes)).toContainEqual(expect.objectContaining({ locale: "ja", key: "a" }));
  const counts = computeReviewCounts(changed, { ...files, en: changed }, hashes, {}, {});
  expect(counts.ja).toMatchObject({ stale: 1, unverified: 0, unverifiedPublic: 0 });
  expect(() => assertEnabledLangsReviewed({ NODE_ENV: "production", ENABLED_LANGS: "ja,en" }, counts)).toThrow("ja: 0 missing and 1 stale");
});

it.each(["principles", "why", "name"])("pins each %s translation to the Japanese source bytes", name => {
  const dir = `app/content/${name}`;
  const digest = createHash("sha256").update(fs.readFileSync(`${dir}/ja.md`, "utf8").replace(/\r\n/g, "\n")).digest("hex");
  for (const file of fs.readdirSync(dir).filter(file => file.endsWith(".md") && file !== "ja.md")) {
    const raw = fs.readFileSync(`${dir}/${file}`, "utf8");
    expect(raw.match(/^<!--[\s\S]*?source-sha256: ([a-f0-9]{64})[\s\S]*?-->/)?.[1], file).toBe(digest);
  }
});

it("uses the same message language names for villages on the server and in the browser", () => {
  for (const lang of LANGS) {
    expect(villageName({ language: lang, name: "" }, "ja")).toBe(m.village_language_name({ language: localizedLanguageLabel(lang, "ja") }, { locale: "ja" }));
  }
  expect(villageName({ language: "ja", name: "Named village" }, "en")).toBe("Named village");
});

it("pins post rules and their prompt version when Markdown instructions change", () => {
  const text = LANGS.map(to => translationSystemPrompt(to === "ja" ? "en" : "ja", to, "fixed")).join("\n");
  expect({ post: PROMPT_VERSION, chat: CHAT_PROMPT_VERSION, shared: createHash("sha256").update(text).digest("hex") },
    "Review changed instructions and bump the affected prompt versions before updating this fingerprint.")
    .toEqual({ post: "translate-v14", chat: "chat-v4", shared: "66140d79329868ed0ce21c164ed8702d065188e7af03da08e83421dcc80ca4ac" });
});

it("keeps the plain-text chat prompt unchanged by post-only Markdown rules", () => {
  const text = LANGS.map(to => translationSystemPrompt(to === "ja" ? "en" : "ja", to, "fixed", true)).join("\n");
  expect({ version: CHAT_PROMPT_VERSION, hash: createHash("sha256").update(text).digest("hex") })
    .toEqual({ version: "chat-v4", hash: "340c63abe37ffc7d4e3f4ecc110e3d86f5209d4a14be5372544eac9e88a3a589" });
});
