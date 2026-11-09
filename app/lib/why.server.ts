import jaSource from "~/content/why/ja.md?raw";
import enSource from "~/content/why/en.md?raw";
import frSource from "~/content/why/fr.md?raw";
import deSource from "~/content/why/de.md?raw";
import zhHantSource from "~/content/why/zh-Hant.md?raw";
import zhHansSource from "~/content/why/zh-Hans.md?raw";
import koSource from "~/content/why/ko.md?raw";
import thSource from "~/content/why/th.md?raw";
import viSource from "~/content/why/vi.md?raw";
import esSource from "~/content/why/es.md?raw";
import ptSource from "~/content/why/pt.md?raw";
import ruSource from "~/content/why/ru.md?raw";
import arSource from "~/content/why/ar.md?raw";
import hiSource from "~/content/why/hi.md?raw";
import idSource from "~/content/why/id.md?raw";
import bnSource from "~/content/why/bn.md?raw";
import urSource from "~/content/why/ur.md?raw";
import { createSignedDocuments, type SignedDocument } from "~/lib/signed-document.server";

// Signed account of why the site was started. Japanese is the original.
const sources = {
  ja: jaSource, en: enSource, fr: frSource, de: deSource, "zh-Hant": zhHantSource, "zh-Hans": zhHansSource, ko: koSource, th: thSource, vi: viSource,
  es: esSource, pt: ptSource, ru: ruSource, ar: arSource, hi: hiSource, id: idSource, bn: bnSource, ur: urSource,
} as const;

export type WhyLang = keyof typeof sources;
export type WhyDocument = SignedDocument<WhyLang>;
export const whyDocuments = createSignedDocuments<WhyLang>("why", sources, "en");
export const WHY_LANGS = whyDocuments.languages;
export const isWhyLang = whyDocuments.isLanguage;
export const whyFor = whyDocuments.forLanguage;
export const initializeWhyMarkdown = whyDocuments.initialize;
