import type { Route as AreaRoute } from "../../app/routes/+types/area";
import type { Route as FollowingRoute } from "../../app/routes/+types/following";
import type { Route as HomeRoute } from "../../app/routes/+types/home";
import type { Route as LatestRoute } from "../../app/routes/+types/latest";
import type { Route as MemberLayoutRoute } from "../../app/routes/+types/member-layout";
import type { Route as NotificationsRoute } from "../../app/routes/+types/notifications";
import type { Route as OnboardingRoute } from "../../app/routes/+types/onboarding";
import type { Route as SearchRoute } from "../../app/routes/+types/search";
import type { Route as SettingsRoute } from "../../app/routes/+types/settings";
import type { Route as TopicRoute } from "../../app/routes/+types/topic";
import type { Route as VillageChatRoute } from "../../app/routes/+types/village-chat";
import { readingVersions } from "~/lib/reading.server";
import { m } from "~/paraglide/messages.js";
import { READING_CHUNK_PARAM, type ReadingPage } from "~/lib/reading-page";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";

// Each call gets fresh defaults, including the nested arrays and objects.
export function loaderFixture<Data>(defaults: () => Data) {
  return (overrides: Partial<Data> = {}): Data => ({ ...defaults(), ...overrides });
}

const emptyList = (): ReadingPage => ({
  param: READING_CHUNK_PARAM, legacyParam: "page", after: null, start: null, next: null,
  count: 0, older: false, restored: false,
});
const listDefaults = (path: string) => ({
  list: emptyList(), page: 1, hasNext: false, topics: [], langParam: null,
  stanceMessage: null, aiOpen: { mdPath: path, mdUrl: `http://localhost${path}` },
});
const readingLanguage = () => ({ current: "ja" as const, usual: "ja" as const, enabled: ["ja" as const] });

export const homeData = loaderFixture<HomeRoute.ComponentProps["loaderData"]>(() => ({
  ...listDefaults("/home.md"), reader: false, layout: "unified", order: "created", filter: "all",
  readingLanguage: readingLanguage(), followingAvailable: false, scope: "all", scopeAction: "/", filterReset: "/",
}));
export const followingData = loaderFixture<FollowingRoute.ComponentProps["loaderData"]>(() => ({
  ...listDefaults("/following.md"), all: false, hasFollowedTopics: false, asksOnly: false,
}));
export const areaData = loaderFixture<AreaRoute.ComponentProps["loaderData"]>(() => ({
  ...listDefaults("/a/ja.md"), reader: false, lang: "ja", order: "created", filter: "all", readingLanguage: readingLanguage(),
}));
export const latestData = loaderFixture<LatestRoute.ComponentProps["loaderData"]>(() => ({
  ...listDefaults("/latest.md"), reader: false, asksOnly: false,
}));

export const searchData = loaderFixture<SearchRoute.ComponentProps["loaderData"]>(() => ({
  state: "results", q: "", members: [], villages: [], hits: [], retryMinutes: 0,
  literalOnly: false, lang: "", carryLang: null,
}));

type MemberNavigation = Extract<MemberLayoutRoute.ComponentProps["loaderData"], { reader: false }>;
export const memberNavigationData = loaderFixture<MemberNavigation>(() => ({
  reader: false, userId: "fixture", handle: "fixture", passkeyPrompt: { cookieName: "fixture.prompt", deferred: false },
  hasPasskey: true, credentialFresh: false, isOperator: false, canInvite: false,
  isModerator: false, apiDrafts: 0, unreadNotifications: 0, followedUnread: false, welcome: null,
}));

export const onboardingData = loaderFixture<OnboardingRoute.ComponentProps["loaderData"]>(() => ({
  draftOwner: "fixture", village: null, defaultMainLang: "ja", publicReading: false,
  opening: {}, trialRequired: false, ownHandle: null, existing: false, country: null, adult: false,
  excluded: false, countries: [], notices: { privacy: false, terms: false },
}));
export const settingsData = loaderFixture<SettingsRoute.ComponentProps["loaderData"]>(() => ({
  homeArea: "ja", handle: "fixture", displayLang: null, readLangs: ["ja"], nextAreaChange: null,
  nextHandleChange: null, saved: null, passkeys: [], emailPref: "auto", signPosts: false,
  shareBookmarklet: "", nushi: null, avatarUrl: "/avatar/fixture", avatarUploaded: false, introEntryId: null,
  returnTo: null, displayName: null, displayNameLatin: null, colorScheme: null, credentialFresh: false,
}));

type NotificationsData = NotificationsRoute.ComponentProps["loaderData"];
export const notificationsData = loaderFixture<NotificationsData>(() => ({
  items: [], page: 1, hasNext: false, unreadTotal: 0, homeArea: "ja",
}));
export const notificationItem = loaderFixture<NotificationsData["items"][number]>(() => ({
  id: 1, kind: "mention", createdAt: "2026-10-03T00:00:00Z", read: true, unavailable: false,
  actorHandle: null, topicTitle: null, threadId: null, entryId: null, count: 1, latestUnavailable: false,
  action: null, reason: null, note: null, until: null, actionId: null, appealStatus: null,
  decisionNote: null, appealReversed: null, excerpt: null, excerptLang: null, entryLang: null,
  href: null, followedHref: null,
}));

type TopicData = TopicRoute.ComponentProps["loaderData"];
type VisibleTopic = Extract<TopicData["topic"], { placeholder: null }>;
type VisibleReply = Extract<TopicData["replies"][number], { placeholder: null }>;
type VisibleEntry = Omit<VisibleTopic, "title" | "headline" | "reading" | "longTranslation">;
const entryData = loaderFixture<VisibleEntry>(() => ({
  id: 1, placeholder: null, lang: "ja", langCode: null, avatarUrl: undefined,
  authorHandle: "fixture", authorName: null, authorNameLatin: null,
  html: "<p>Body</p>", createdAt: new Date("2026-10-03T00:00:00Z"), editedAt: null,
  stanceTag: null, canEdit: false, own: false, posted: false, hidden: false, hiddenAction: null,
  reported: false, translationReports: [], canModerate: false,
  display: { shown: "original", pending: false, translation: null },
  reactions: { insightful: { total: 0, langs: 0 }, mine: false }, reviewHref: null,
}));
export function topicEntry(overrides: Partial<VisibleTopic> = {}): VisibleTopic {
  const entry = { ...entryData(), title: "A topic", headline: null, longTranslation: false, ...overrides };
  return { ...entry, reading: overrides.reading ?? readingVersions(entry.html, entry.lang, entry.display) };
}
export const replyEntry = loaderFixture<VisibleReply>(() => ({
  ...entryData(), parent: null, nushiParentId: null,
}));
export const topicData = loaderFixture<TopicData>(() => ({
  aiMaterialLinks: [], nushi: { entries: {}, controls: "", reply: "", pending: [] },
  nushiAvailable: false, reader: false, askAi: null, canReply: false, respondWithPost: null,
  stanceResume: null, share: null, introSelected: false, postedNotice: null, articleViews: null, readingMark: null, edited: null,
  topic: topicEntry(), replies: [],
  question: { asksStance: false, isAlt: false, origin: null, locked: false, canFix: false, stance: null, reasons: null, objections: null },
  loadedAt: "2026-10-03T00:00:00.000Z", stanceTag: null, follow: null, saved: false, postedFollowed: false,
  replyTarget: null, replyToTopic: false, writeTag: null, langParam: "en", markdownHref: "/t/1.md",
  replyCount: 0, replyLangCount: 0, replyBranches: null, page: 1, hasNextPage: false, pageCount: 1,
  latestReplyHref: null, operator: false, ownerId: null, connectDraftLabel: m.connect_draft_link(), defaultLang: "ja", signPosts: false,
  displayLang: "en", readingLanguage: { current: "en", enabled: ["ja", "en"], usual: "en" }, translating: [],
  related: { rows: [], omitted: false, hasNext: false, pageCount: 1 },
  aiOpen: { mdUrl: "http://localhost/t/1.md", mdPath: "/t/1.md" },
}));

type ChatData = VillageChatRoute.ComponentProps["loaderData"];
const chatDefaults = () => ({
  village: { slug: "display-chat", name: "Display chat", description: "", language: null, kind: "open", iconUrl: "" },
  readers: 2, chatNushiAvailable: false, targetUnavailable: false, privacyAvailable: false, linkLang: null,
  report: null, reported: null, now: Date.parse("2026-10-16T00:00:00Z"), window: "", latest: false,
});
export const chatData = loaderFixture<Extract<ChatData, { consentRequired: false }>>(() => ({
  ...chatDefaults(), messages: [], seq: 2, ended: false, historical: false, hasNewer: true, readSeq: 0,
  readFrom: null, unreadAfter: 0, before: null, consentRequired: false,
}));
export const chatConsentData = loaderFixture<Extract<ChatData, { consentRequired: true }>>(() => ({
  ...chatDefaults(), consentRequired: true, consentVersion: CHAT_CONSENT_VERSION, previousConsentVersion: null,
}));
