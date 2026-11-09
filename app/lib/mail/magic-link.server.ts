import { defaultUiLocale, isEnabledLang } from "~/lib/enabled-langs.server";
import { isLocale, type Locale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import type { MailMessage } from "./mail.server";

// Plain-text magic-link mail in the requesting page's interface locale (en/ja).
// Pass expiry minutes matching auth configuration expiresIn in app/lib/auth/plugins.ts.
export const MAGIC_LINK_MINUTES = 15;

// Turns the language value a request carried into a usable locale. An unknown value and a language that is not enabled (ENABLED_LANGS; the language of mails is limited
// to the enabled languages too) are null (the caller then uses defaultUiLocale()).
export function mailLocale(value: unknown): Locale | null {
  return isLocale(value) && isEnabledLang(value) ? value : null;
}

// Mail language for a member: the stored interface locale, otherwise the main language when it is an enabled language (a member whose interface locale
// was never stored still gets mail in the language they chose at signup), otherwise the site default.
export function memberMailLocale(uiLocale: unknown, homeArea: unknown): Locale {
  return mailLocale(uiLocale) ?? mailLocale(homeArea) ?? defaultUiLocale();
}

// `invitation` is set when the code was asked for on an invitation page: the mail then speaks of signing up, not of logging in.
export function magicLinkMail(input: { to: string; url: string; code: string; locale: Locale; invitation?: boolean }): MailMessage {
  const options = { locale: input.locale };
  const values = { url: input.url, code: input.code.replace(/^(\d{3})(\d{3})$/, "$1 $2"), minutes: MAGIC_LINK_MINUTES };
  return input.invitation
    ? { to: input.to, locale: input.locale, subject: m.mail_invite_subject({}, options), text: m.mail_invite_body(values, options) }
    : { to: input.to, locale: input.locale, subject: m.mail_magic_link_subject({}, options), text: m.mail_magic_link_body(values, options) };
}
