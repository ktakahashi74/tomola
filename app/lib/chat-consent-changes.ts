import { CHAT_CONSENT_VERSION } from "./village-chat-consent";
import { m } from "~/paraglide/messages.js";

// Add one entry for each new consent version. Returning members see every
// change after their last agreement, in version order.
const changes = [
  { version: 2, points: (_providerChange: string) => [m.village_chat_changes_v2_readers(), m.village_chat_changes_v2_review(), m.village_chat_changes_v2_spam()] },
  { version: 3, points: (providerChange: string) => [providerChange] },
  { version: 4, points: (_providerChange: string) => [m.chat_consent_v4_replies(), m.chat_consent_v4_nushi()] },
];

export function chatConsentChanges(previousVersion: number | null, providerChange: string): string[] {
  if (previousVersion === null || previousVersion < 1) return [];
  return changes.filter(change => change.version > previousVersion && change.version <= CHAT_CONSENT_VERSION)
    .flatMap(change => change.points(providerChange));
}
