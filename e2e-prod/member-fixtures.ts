import type { SeedMember } from "../e2e/member-fixtures";
import { EARLY_MEMBERS } from "../e2e/early-members";

export const PROD_MEMBERS: readonly SeedMember[] = [
  { email: "scribe_other_prod@example.com", handle: "scribe_other_prod", homeArea: "en", uiLocale: "en" },
  { email: "older_keep_prod@example.com", handle: "older_keep_prod", homeArea: "en", uiLocale: "en" },
  { email: "style_preloads_reader@example.com", handle: "style_preloads_reader", homeArea: "en", uiLocale: "en" },
  ...EARLY_MEMBERS,
  { email: "pat@example.com", handle: "member_page_pat", homeArea: "en", uiLocale: "en" },
  { email: "kai@example.com", handle: "earlywriter", homeArea: "en", uiLocale: "en" },
  { email: "reading_type@example.com", handle: "reading_type", homeArea: "en", readLangs: ["ja", "en"], uiLocale: "en" },
  { email: "editor_default_prod@example.com", handle: "editor_default_prod", homeArea: "en", uiLocale: "en" },
  { email: "media_prod@example.com", handle: "media_prod", homeArea: "en", uiLocale: "en" },
  { email: "language_fallback_prod@example.com", handle: "language_fallback", homeArea: "ja", uiLocale: "en" },
];
