import jaSource from "~/content/name/ja.md?raw";
import enSource from "~/content/name/en.md?raw";
import frSource from "~/content/name/fr.md?raw";
import deSource from "~/content/name/de.md?raw";
import zhHantSource from "~/content/name/zh-Hant.md?raw";
import zhHansSource from "~/content/name/zh-Hans.md?raw";
import koSource from "~/content/name/ko.md?raw";
import thSource from "~/content/name/th.md?raw";
import viSource from "~/content/name/vi.md?raw";
import esSource from "~/content/name/es.md?raw";
import ptSource from "~/content/name/pt.md?raw";
import ruSource from "~/content/name/ru.md?raw";
import arSource from "~/content/name/ar.md?raw";
import hiSource from "~/content/name/hi.md?raw";
import idSource from "~/content/name/id.md?raw";
import bnSource from "~/content/name/bn.md?raw";
import urSource from "~/content/name/ur.md?raw";
import { createSignedDocuments, type SignedDocument } from "~/lib/signed-document.server";

// Signed account of the name of the site. Japanese is the original.
const sources = {
  ja: jaSource, en: enSource, fr: frSource, de: deSource, "zh-Hant": zhHantSource, "zh-Hans": zhHansSource, ko: koSource, th: thSource, vi: viSource,
  es: esSource, pt: ptSource, ru: ruSource, ar: arSource, hi: hiSource, id: idSource, bn: bnSource, ur: urSource,
} as const;

export type NameLang = keyof typeof sources;
export type NameDocument = SignedDocument<NameLang>;
export const nameDocuments = createSignedDocuments<NameLang>("name", sources, "en");
export const NAME_LANGS = nameDocuments.languages;
export const isNameLang = nameDocuments.isLanguage;
export const nameFor = nameDocuments.forLanguage;
export const initializeNameMarkdown = nameDocuments.initialize;
