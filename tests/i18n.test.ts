import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LANGS } from "~/lib/languages";
import { messageText, ALL_LOCALES, checkMessages, placeholders, SOURCE_LOCALE, TARGET_LOCALES, type Messages } from "~/lib/i18n/messages";
import { checkStale, HASHES_FILE, parseHashes } from "~/lib/i18n/source-hashes";
import { magicLinkMail } from "~/lib/mail/magic-link.server";
import { itemText } from "~/lib/mail/notification.server";
import { renderMarkdown } from "~/lib/markdown.server";
import { cookieName } from "~/paraglide/runtime.js";

// Nine UI languages: en/ja must be complete; other message files may omit untranslated keys, using the same checks as pnpm i18n:translate --check.
// Real message text must support mail and fixed footnote labels in all nine languages.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const read = (locale: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Messages;
const files = Object.fromEntries(ALL_LOCALES.map((l) => [l, read(l)]));
const keys = (m: Messages) => Object.keys(m).filter((k) => k !== "$schema");
const hashesText = () => fs.readFileSync(path.join(process.cwd(), "messages", HASHES_FILE), "utf8");

describe("the nine languages of the interface", () => {
  it("are the languages of the site: LANGS, the Paraglide locales and the files agree", () => {
    expect([...ALL_LOCALES].sort()).toEqual([...LANGS].sort());
    const settings = JSON.parse(fs.readFileSync(path.join(process.cwd(), "project.inlang", "settings.json"), "utf8")) as { baseLocale: string; locales: string[] };
    expect(settings.baseLocale).toBe(SOURCE_LOCALE);
    expect([...settings.locales].sort()).toEqual([...LANGS].sort());
    expect([...TARGET_LOCALES].sort()).toEqual(LANGS.filter(locale => locale !== "en" && locale !== "ja").sort());
    expect(fs.readdirSync(path.join(process.cwd(), "messages")).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()).toEqual([...LANGS].map((l) => `${l}.json`).sort());
  });

  it("have every source key in en/ja, no extra key in any language, the same {inputs}, no empty message and the same line structure (the same check as pnpm i18n:translate --check)", () => {
    expect(checkMessages(files, { locales: ALL_LOCALES })).toEqual([]);
    expect(keys(files.ja).sort()).toEqual(keys(files.en).sort());
    for (const locale of TARGET_LOCALES) expect(keys(files[locale]).filter(key => !(key in files.en)), locale).toEqual([]);
  });

  it("have no stale translation: no key of messages/en.json changed since it was translated (the fingerprints in messages/.source-hashes.json), the same check as --check", () => {
    const recorded = parseHashes(hashesText());
    expect(checkStale(files.en, files, recorded)).toEqual([]);
  });

  it("keep the product name and the placeholders of the e-mails in every language", () => {
    for (const locale of ALL_LOCALES) {
      expect(files[locale].site_name, locale).toBe("tomola");
      expect(placeholders(files[locale].mail_magic_link_body ?? files.en.mail_magic_link_body), locale).toEqual(["code", "minutes", "url"]);
    }
  });

  it("really are translations: apart from names, a few shared words no non-English language repeats the English text", () => {
    for (const locale of ALL_LOCALES.filter((l) => l !== "en")) {
      // A message made only of placeholders and punctuation (a table cell such as "{a} / {b} ({c})") has no words to translate.
      const hasWords = (text: string) => /\p{L}/u.test(text.replace(/\{[^}]*\}/g, ""));
      const same = keys(files.en).filter((k) => files[locale][k] === files.en[k] && messageText(files.en[k]).trim().split(/\s+/).length >= 3 && hasWords(messageText(files.en[k])));
      expect(same, locale).toEqual([]);
    }
  });

  it("write the login-link e-mail in each language, with the link and the expiry", () => {
    const url = "https://forum.example.org/auth/confirm?token=abc";
    for (const locale of ALL_LOCALES) {
      const mail = magicLinkMail({ to: "a@example.org", url, code: "123456", locale });
      expect(mail.text, locale).toContain(url);
      expect(mail.text, locale).toContain("15");
      expect(mail.subject, locale).toContain("tomola");
      if (locale !== "en" && "mail_magic_link_subject" in files[locale]) expect(mail.subject, locale).not.toBe(magicLinkMail({ to: "a@example.org", url, code: "123456", locale: "en" }).subject);
    }
  });

  it("write the notification e-mail items in each language, with the title, the excerpt and the link", () => {
    for (const locale of ALL_LOCALES) {
      const text = itemText({ kind: "reply_to_topic", handle: "hana", title: "TITLE", excerpt: "EXCERPT", url: "https://forum.example.org/t/1" }, locale);
      for (const part of ["hana", "TITLE", "EXCERPT", "https://forum.example.org/t/1"]) expect(text, locale).toContain(part);
    }
  });

  it("put the fixed footnote strings of the Markdown rendering in the language of the text, for all nine", async () => {
    const md = "text[^1]\n\n[^1]: note";
    for (const locale of ALL_LOCALES) {
      const html = (await renderMarkdown(md, { lang: locale }));
      expect(html.match(/<h2[^>]*id="[^"]*footnote-label"[^>]*>([^<]*)<\/h2>/)?.[1], locale).toBe((files[locale].md_footnotes ?? files.en.md_footnotes));
      expect(html, locale).toContain(`aria-label="${messageText(files[locale].md_footnote_back ?? files.en.md_footnote_back).replace("{index}", "1")}"`);
    }
  });

  it("use the cookie name that the locale middleware writes", () => {
    expect(cookieName).toBe("PARAGLIDE_LOCALE");
  });
});
