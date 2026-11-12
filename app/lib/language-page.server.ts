import { operatorConfig } from "~/lib/operator-config.server";
import { enabledLangs, previewLangs } from "~/lib/enabled-langs.server";
import { LANGS, type Lang } from "~/lib/languages";
import { PRINCIPLES_LANGS, PRINCIPLES_LANG_LABELS, type PrinciplesLang } from "~/lib/principles-languages";
import { m } from "~/paraglide/messages.js";

type Env = Record<string, string | undefined>;

// Availability comes from the same sources used by the language selectors and principles editions.
export function languagePage(locale: Lang, env: Env = process.env) {
  const enabled = enabledLangs(env);
  const preview = previewLangs(env);
  const names = new Intl.DisplayNames([locale], { type: "language", languageDisplay: "standard" });
  const options = { locale };
  const groups = [
    { id: "open", title: m.languages_open({}, options), tags: enabled.filter(lang => !preview.includes(lang)) },
    { id: "preview", title: m.languages_preview({}, options), tags: preview },
    { id: "supported", title: m.languages_supported({}, options), tags: LANGS.filter(lang => !enabled.includes(lang)) },
    { id: "principles", title: m.languages_principles({}, options), tags: PRINCIPLES_LANGS.filter(lang => !(LANGS as readonly string[]).includes(lang)) },
  ];
  const named = (tag: PrinciplesLang) => ({ tag, nativeName: PRINCIPLES_LANG_LABELS[tag], name: names.of(tag) ?? PRINCIPLES_LANG_LABELS[tag] });
  const query = new URLSearchParams({ subject: m.languages_request_subject({}, options), body: m.languages_request_body({}, options) });
  return {
    locale,
    title: m.languages_title({}, options),
    opening: m.languages_opening({}, options),
    writingTitle: m.languages_writing_title({}, options),
    writingHelp: m.languages_writing_help({}, options),
    readingHelp: m.languages_reading_help({}, options),
    principlesLabel: m.footer_principles({}, options),
    groups: groups.map(group => ({ id: group.id, title: group.title, languages: group.tags.map(named) })),
    requestTitle: m.languages_request_title({}, options),
    requestHelp: m.languages_request_help({}, options),
    requestLabel: m.languages_request_email({}, options),
    mailto: `mailto:${operatorConfig().contactEmail}?${query.toString().replaceAll("+", "%20")}`,
  };
}

export function languagePageMarkdown(page: ReturnType<typeof languagePage>): string {
  return [
    `# ${page.title}`,
    `${page.opening} [${page.principlesLabel}](/principles#s2)`,
    `## ${page.writingTitle}`, page.writingHelp, page.readingHelp,
    ...page.groups.filter(group => group.languages.length).map(group => `## ${group.title}\n\n${group.languages.map(lang => `- ${lang.nativeName} — ${lang.name}`).join("\n")}`),
    `## ${page.requestTitle}`,
    page.requestHelp,
    `[${page.requestLabel}](${page.mailto})`,
  ].join("\n\n") + "\n";
}
