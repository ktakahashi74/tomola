import { acceptTrialFixture } from "./trial-fixture";
// E2E seed, run with tsx before starting the dev server: member kim in the Japanese area, their 35 topics,
// an invitation for the first member hana@example.com, one for mika@example.com in the machine-readable tests (e2e/machine.spec.ts),
// one for pat@example.com in the authentication tests (e2e/auth.spec.ts), and one for operator olga@example.com in moderation and notification tests
// (e2e/moderation.spec.ts; olga is in OPERATOR_EMAILS in e2e/global-setup.ts), plus lena@example.com in UI-language tests (e2e/i18n.spec.ts),
// quinn@example.com in question tests (e2e/questions.spec.ts), saki@example.com in stance tests (e2e/stances.spec.ts),
// The glossary tests use operator gwen's invitation and the glossary entries (three for Japanese/English, four needing review for French). The last stance scenarios use Japanese member rina
// and operator opal; the follow tests use fiona and the mention tests use mei. gwen and opal are in global-setup.ts's OPERATOR_EMAILS.
// Remove the topic translation jobs so the worker does not put the topics used by the tests behind the seeded topics.
// Write invitation URLs on separate stdout lines, in this order: hana, mika, pat, olga, lena, quinn, saki, gwen, rina, opal, fiona, mei, disco_aki, disco_ben, signer, mcp_member, mobile_ui, enrollment, language.
import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "../app/lib/db/client.server";
import { glossaryEntries, glossaryRevisions, jobs, profiles, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { createGlossaryEntry } from "../app/lib/glossary.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";
import { ensureLanguageVillages } from "../app/lib/villages.server";
import { villagesEnabled } from "../app/lib/villages-enabled.server";
import { createProfile } from "../app/lib/profiles.server";

const db = await getDb();
if (villagesEnabled()) await ensureLanguageVillages(db);
await db.insert(user).values({ id: "seed-kim", name: "", email: "kim@example.com", emailVerified: true });
const profile = await createProfile(db, "seed-kim", { handle: "kim", homeArea: "ja", readLangs: ["ja"] });
if (!profile.ok) throw new Error(`seed profile failed: ${profile.error}`);
const base = Date.UTC(2026, 0, 1);
{
  const author = "site-banner-author";
  await db.insert(user).values({ id: author, name: "", email: "site_banner_author@example.com", emailVerified: true });
  const profile = await createProfile(db, author, { handle: "site_banner_author", homeArea: "en" });
  if (!profile.ok) throw new Error(profile.error);
  const topic = await createTopic(db, author, { lang: "en", title: "Test-site notice reading fixture", body: "A dedicated reading fixture." }, { now: new Date("2016-01-01T00:00:00Z") });
  if (!topic.ok) throw new Error(topic.error);
  const invitation = await createInvitation(db, { email: "site_banner_signup@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "test-site-banner.json"), JSON.stringify({ topic: topic.id, invite: invitation.token }));
}
for (let i = 1; i <= 35; i++) {
  const res = await createTopic(db, "seed-kim", { lang: "ja", title: `Seed topic ${i}`, body: `種の話題 ${i}` }, { now: new Date(base + i * 60_000) });
  if (!res.ok) throw new Error(`seed topic ${i} failed: ${res.error}`);
}
// A dedicated author owns the pagination fixture; other suites may add Kim's posts.
await db.insert(user).values({ id: "member-pagination", name: "", email: "member_pagination@example.com", emailVerified: true });
const paginationProfile = await createProfile(db, "member-pagination", { handle: "member_pagination", homeArea: "ja" });
if (!paginationProfile.ok) throw new Error(paginationProfile.error);
const paginationCount = 35;
for (let i = 0; i < paginationCount; i++) {
  const topic = await createTopic(db, "member-pagination", { lang: "ja", title: `Member pagination ${i}`, body: `ページ送り ${i}` }, { now: new Date(Date.UTC(2025, 0, 1, 0, i)) });
  if (!topic.ok) throw new Error(topic.error);
}
fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "member-pagination.json"), JSON.stringify({ handle: "member_pagination", count: paginationCount }));
await db.delete(jobs).where(inArray(jobs.kind, ["translate_entry", "translate_title"]));
{
  const { seedEvalSet } = await import("./seed-eval-set");
  await seedEvalSet(db);
}
{
  const { seedReadLang } = await import("./seed-read-lang");
  await seedReadLang(db);
  const { seedWritingLanguage } = await import("./seed-writing-language");
  await seedWritingLanguage(db, path.dirname(process.env.PGLITE_DATA_DIR!));
}
{
  const { seedInsightfulOrder } = await import("./seed-insightful-order");
  await seedInsightfulOrder(db);
}
{
  const { seedReadingPage } = await import("./seed-reading-page");
  await seedReadingPage(db);
}
{
  const { seedLatestReplyFixture } = await import("./seed-latest-reply");
  await seedLatestReplyFixture(db);
}
{
  const { seedDiscussionReturn } = await import("./seed-discussion-return");
  await seedDiscussionReturn(db);
}
{
  const { seedPlainWords } = await import("./seed-plain-words");
  await seedPlainWords(db);
}
{
  const { seedSmallPolish } = await import("./seed-small-polish");
  await seedSmallPolish(db);
}
{
  const { seedRichEditor } = await import("./seed-rich-editor");
  await seedRichEditor(db);
}
{
  const { seedReplyBranches } = await import("./seed-reply-branches");
  await seedReplyBranches(db);
}
// Glossary entries for e2e/glossary.spec.ts, last changed by kim on 2026-01-02. Two have the target language ja, one has the target language en (a Japanese moderator cannot edit it).
for (const input of [
  { term: "corrigibility", lang: "en", targetLang: "ja", candidates: ["修正可能性", "コリジビリティ"], note: "" },
  { term: "reward hacking", lang: "en", targetLang: "ja", candidates: ["報酬ハッキング"], note: "", keepOriginal: true },
  { term: "整合性", lang: "ja", targetLang: "en", candidates: ["alignment"], note: "" },
]) {
  const res = await createGlossaryEntry(db, { userId: "seed-kim", scope: { operator: true, langs: [] } }, input, { now: new Date(Date.UTC(2026, 0, 2)) });
  if (!res.ok) throw new Error(`seed glossary entry failed: ${res.error}`);
}
// Entries that need review, for the bulk "mark as reviewed" (the last tests of e2e/glossary.spec.ts). The target language is fr: only the moderator appointed for French in that test may edit them.
for (const input of [
  { term: "fine-tuning", lang: "en", targetLang: "fr", candidates: ["ajustement fin"], note: "" },
  { term: "red teaming", lang: "en", targetLang: "fr", candidates: ["tests adverses"], note: "" },
  { term: "interpretability", lang: "en", targetLang: "fr", candidates: ["interprétabilité"], note: "" },
  { term: "scaling law", lang: "en", targetLang: "fr", candidates: ["loi d'échelle"], note: "" },
]) {
  const res = await createGlossaryEntry(db, { userId: "seed-kim", scope: { operator: true, langs: [] } }, { ...input, needsReview: true }, { now: new Date(Date.UTC(2026, 0, 4)) });
  if (!res.ok) throw new Error(`seed glossary entry failed: ${res.error}`);
}
// An entry that nobody is recorded as having changed (as the data that came before the history table: updated_by is null), last changed on 2026-01-03; the target language is fr,
// so that it stays out of the Japanese lists.
const [orphan] = await db.insert(glossaryEntries).values({ term: "orphan", lang: "en", targetLang: "fr", candidates: ["orphelin"], updatedAt: new Date(Date.UTC(2026, 0, 3)) }).returning({ id: glossaryEntries.id });
await db.insert(glossaryRevisions).values({
  entryId: orphan.id,
  before: null,
  after: { term: "orphan", candidates: ["orphelin"], note: "", keepOriginal: false, needsReview: false },
  editorId: null,
  via: "import",
  createdAt: new Date(Date.UTC(2026, 0, 3)),
});
const { token } = await createInvitation(db, { email: "hana@example.com" });
const { token: mikaToken } = await createInvitation(db, { email: "mika@example.com" });
const { token: patToken } = await createInvitation(db, { email: "pat@example.com" });
const { token: olgaToken } = await createInvitation(db, { email: "olga@example.com" });
const { token: lenaToken } = await createInvitation(db, { email: "lena@example.com" });
const { token: quinnToken } = await createInvitation(db, { email: "quinn@example.com" });
const { token: sakiToken } = await createInvitation(db, { email: "saki@example.com" });
const { token: gwenToken } = await createInvitation(db, { email: "gwen@example.com" });
const { token: rinaToken } = await createInvitation(db, { email: "rina@example.com" });
const { token: opalToken } = await createInvitation(db, { email: "opal@example.com" });
const { token: fionaToken } = await createInvitation(db, { email: "fiona@example.com" });
const { token: meiToken } = await createInvitation(db, { email: "mei@example.com" });
const { token: discoveryAkiToken } = await createInvitation(db, { email: "disco_aki@example.com" });
const { token: discoveryBenToken } = await createInvitation(db, { email: "disco_ben@example.com" });
const { token: signingToken } = await createInvitation(db, { email: "signer@example.com" });
const { token: mcpToken } = await createInvitation(db, { email: "mcp@example.com" });
const { token: mobileToken } = await createInvitation(db, { email: "mobile@example.com" });
const { token: enrollmentToken } = await createInvitation(db, { email: "enrollment@example.com" });
const { token: languageToken } = await createInvitation(db, { email: "language@example.com" });
const { token: navigationToken } = await createInvitation(db, { email: "navigation_operator@example.com" });
const { token: detectToken } = await createInvitation(db, { email: "language_signer@example.com" });
const { token: fallbackToken } = await createInvitation(db, { email: "language_fallback@example.com" });
// Dedicated accounts for login-ease.spec.ts; never reuse another suite's invite.
const { token: loginConfirmToken } = await createInvitation(db, { email: "login_ease_confirm@example.com" });
const { token: loginPromptToken } = await createInvitation(db, { email: "login_ease_prompt@example.com" });
const { token: loginUnsupportedToken } = await createInvitation(db, { email: "login_ease_unsupported@example.com" });
const { token: loginCodeToken } = await createInvitation(db, { email: "login_ease_code@example.com" });
const { token: loginMcpToken } = await createInvitation(db, { email: "login_ease_mcp@example.com" });
// Dedicated invitation for login-flow.spec.ts.
const { token: loginFlowToken } = await createInvitation(db, { email: "login_flow@example.com" });
const { token: returnReaderToken } = await createInvitation(db, { email: "discussion_reader@example.com" });
const { token: returnWriterToken } = await createInvitation(db, { email: "discussion_writer@example.com" });
const { token: aiDraftToken } = await createInvitation(db, { email: "ai_drafter@example.com" });
const { token: loginPolishToken } = await createInvitation(db, { email: "login_polish@example.com" });
const { token: entryHeaderToken } = await createInvitation(db, { email: "entry_header@example.com" });
// Reserve both the invitation and member for the list-controls suite.
const { token: homeControlsToken } = await createInvitation(db, { email: "home_controls@example.com" });
fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "home-controls-invite.json"), JSON.stringify(inviteUrl(homeControlsToken)));
const { token: titleFirstToken } = await createInvitation(db, { email: "title_first@example.com" });
{
  // This suite owns its invitation and signed-in member; keep stdout's protocol intact.
  const { token: aiOpenReturnToken } = await createInvitation(db, { email: "ai_open_return@example.com" });
  const aiOpenReturnTopic = await createTopic(db, "seed-kim", { lang: "en", title: "AI reading receipt fixture", body: "## Reading together\n\nA short article for the local AI reading fixture.\n\n## Coming back\n\nReaders can return here without losing the discussion." });
  if (!aiOpenReturnTopic.ok) throw new Error(aiOpenReturnTopic.error);
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "ai-open-return.json"), JSON.stringify({ invite: inviteUrl(aiOpenReturnToken), topicId: aiOpenReturnTopic.id }));
}
{
  const { token: mediaToken } = await createInvitation(db, { email: "media_uploader@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "media.json"), JSON.stringify({ invite: inviteUrl(mediaToken) }));
}
{
  const { token: screenTrimToken } = await createInvitation(db, { email: "screen_trimmer@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "screen-trim.json"), JSON.stringify({ invite: inviteUrl(screenTrimToken) }));
}
{
  const { token: deletedRepliesToken } = await createInvitation(db, { email: "deleted_replies@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "deleted-replies.json"), JSON.stringify({ invite: inviteUrl(deletedRepliesToken) }));
}
{
  const { seedTitleFirst } = await import("./seed-title-first");
  await seedTitleFirst(db);
}
await closeDb(db);
console.log(inviteUrl(token));
console.log(inviteUrl(mikaToken));
console.log(inviteUrl(patToken));
console.log(inviteUrl(olgaToken));
console.log(inviteUrl(lenaToken));
console.log(inviteUrl(quinnToken));
console.log(inviteUrl(sakiToken));
console.log(inviteUrl(gwenToken));
console.log(inviteUrl(rinaToken));
console.log(inviteUrl(opalToken));
console.log(inviteUrl(fionaToken));
console.log(inviteUrl(meiToken));
console.log(inviteUrl(discoveryAkiToken));
console.log(inviteUrl(discoveryBenToken));
console.log(inviteUrl(signingToken));
console.log(inviteUrl(mcpToken));
console.log(inviteUrl(mobileToken));
console.log(inviteUrl(enrollmentToken));
console.log(inviteUrl(languageToken));
console.log(inviteUrl(navigationToken));
console.log(inviteUrl(detectToken));
console.log(inviteUrl(fallbackToken));
console.log(inviteUrl(loginConfirmToken));
console.log(inviteUrl(loginPromptToken));
console.log(inviteUrl(loginUnsupportedToken));
console.log(inviteUrl(loginCodeToken));
console.log(inviteUrl(loginMcpToken));
console.log(inviteUrl(loginFlowToken));
console.log(inviteUrl(returnReaderToken));
console.log(inviteUrl(returnWriterToken));
console.log(inviteUrl(aiDraftToken));
console.log(inviteUrl(loginPolishToken));
console.log(inviteUrl(entryHeaderToken));
console.log(inviteUrl(titleFirstToken));
// Additional invitations stay out of the existing stdout protocol.
const { openPgliteDb } = await import("../app/lib/db/client.server");
const relatedDb = await openPgliteDb(process.env.PGLITE_DATA_DIR, { migrate: false });
try {
  const { seedRelatedInvitations } = await import("./seed-related");
  await seedRelatedInvitations(relatedDb);
  const { seedConfirmReasons } = await import("./seed-confirm-reasons");
  await seedConfirmReasons(relatedDb);
  const { seedMembers } = await import("./seed-members");
  await seedMembers(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!), process.env.BETTER_AUTH_URL!);
  const { seedTranslationReportResults } = await import("./seed-translation-report-results");
  await seedTranslationReportResults(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedReadingActions } = await import("./seed-reading-actions");
  await seedReadingActions(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedReadingColumn } = await import("./seed-reading-column");
  await seedReadingColumn(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedReadingLayout } = await import("./seed-reading-layout");
  await seedReadingLayout(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedMemberAvatar } = await import("./seed-member-avatar");
  await seedMemberAvatar(relatedDb);
  const { seedVillageIcons } = await import("./seed-village-icons");
  await seedVillageIcons(relatedDb);
  const { seedDisplayNames } = await import("./seed-display-names");
  await seedDisplayNames(relatedDb);
  const { seedCrossLanguage } = await import("./seed-cross-language");
  await seedCrossLanguage(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedShareCard } = await import("./seed-share-card");
  await seedShareCard(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedUxControls } = await import("./seed-ux-controls");
  await seedUxControls(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedAiModeration } = await import("./seed-ai-moderation");
  await seedAiModeration(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedInputSafety } = await import("./seed-input-safety");
  await seedInputSafety(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedReadingControls } = await import("./seed-reading-controls");
  await seedReadingControls(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedMetaSeparators } = await import("./seed-meta-separators");
  await seedMetaSeparators(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedFrame } = await import("./seed-frame");
  await seedFrame(relatedDb);
  const { seedEarlyActions } = await import("./seed-early-actions");
  await seedEarlyActions(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedVillages } = await import("./seed-villages");
  await seedVillages(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedNavigationShell } = await import("./seed-navigation-shell");
  await seedNavigationShell(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedNavigationDisclosure } = await import("./seed-navigation-disclosure");
  await seedNavigationDisclosure(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedLeftNavigation } = await import("./seed-left-navigation");
  await seedLeftNavigation(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedAiReadiness } = await import("./seed-ai-readiness");
  await seedAiReadiness(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedRetention } = await import("./seed-retention");
  await seedRetention(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedAccountDeletion } = await import("./seed-account-delete");
  await seedAccountDeletion(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedFigureTranslation } = await import("./seed-figure-translation");
  await seedFigureTranslation(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedReadingCounts } = await import("./seed-reading-counts");
  await seedReadingCounts(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedTranslationOnRead } = await import("./seed-translation-on-read");
  await seedTranslationOnRead(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedReadLanguagesAuthor } = await import("./seed-read-languages-author");
  await seedReadLanguagesAuthor(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedLiteralSearch } = await import("./seed-literal-search");
  await seedLiteralSearch(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  // Authentication scenarios keep their invitations and perform the UI flow.
  await createInvitation(relatedDb, { email: "auth_invited_comparison@example.com" });
  const publicInvite = await createInvitation(relatedDb, { email: "public_reading_writer@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "public-reading-invite.json"), JSON.stringify(inviteUrl(publicInvite.token)));
  const helpInvite = await createInvitation(relatedDb, { email: "login_help_invitee@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "login-help.json"), JSON.stringify({ invitation: inviteUrl(helpInvite.token) }));
  await acceptTrialFixture(relatedDb);
  await relatedDb.update(profiles).set({ residenceCountry: null, adultConfirmedAt: null, trialConsentVersion: null, trialConsentAt: null }).where(inArray(profiles.handle, ["privacy_existing", "privacy_restricted"]));
  await relatedDb.update(profiles).set({ stanceConsentVersion: null, stanceConsentAt: null }).where(eq(profiles.handle, "privacy_stance"));
  const privacyMember = await relatedDb.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.handle, "privacy_stance"));
  const privacyQuestion = await createTopic(relatedDb, privacyMember[0].userId, { title: "Separate stance consent", body: "A question for consent checks.", lang: "en", asksStance: true }, { now: new Date(Date.UTC(2025, 0, 1)) });
  if (!privacyQuestion.ok) throw new Error(privacyQuestion.error);
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "privacy-page.json"), JSON.stringify({ questionId: privacyQuestion.id }));
  const languagePageInvitations: Record<string, string> = {};
  for (const locale of ["ja", "en"]) {
    const invitation = await createInvitation(relatedDb, { email: `language_page_${locale}@example.com` });
    languagePageInvitations[locale] = inviteUrl(invitation.token);
  }
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "language-page.json"), JSON.stringify(languagePageInvitations));
  const consentLightInvite = await createInvitation(relatedDb, { email: "consent_light_signup@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "consent-light.json"), JSON.stringify({ invitation: inviteUrl(consentLightInvite.token) }));
  const { seedEditHistory } = await import("./seed-edit-history");
  await seedEditHistory(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));
  const { seedFirstLook } = await import("./seed-first-look");
  await seedFirstLook(relatedDb, path.dirname(process.env.PGLITE_DATA_DIR!));

  // Dedicated invitation for the display-language signup journey.
  {
    const invitation = await createInvitation(relatedDb, { email: "locale_signup@example.com" });
    fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "display-language-signup.json"), JSON.stringify({ invitation: inviteUrl(invitation.token) }));
  }

} finally { await closeDb(relatedDb); }
process.exit(0);
