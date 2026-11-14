import { Link } from "react-router";
import { CHAT_CASE_CONTEXT_COUNT, CHAT_CASE_EXPAND_LIMIT, CHAT_REPORT_RETAIN_DAYS } from "~/lib/chat-access";
import { CHAT_TRANSLATION_CONTEXT_COUNT } from "~/lib/village-chat";
import { chatConsentChanges } from "~/lib/chat-consent-changes";
import { useOperatorSettings } from "~/lib/operator-context";
import { formatOperatorCopy, operatorCopy } from "~/lib/operator-settings";
import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";

export function ChatConsentNotice({ privacyAvailable, previousVersion }: { privacyAvailable: boolean; previousVersion: number | null }) {
  const copy = operatorCopy(useOperatorSettings(), getLocale());
  const changes = chatConsentChanges(previousVersion, copy.chatProviderChange);
  const [ownBefore, ownAfter] = m.village_chat_consent_leaving({ ownMessages: "\u0000" }).split("\u0000");
  const [privacyBefore, privacyAfter] = m.village_chat_consent_privacy({ privacy: "\u0000" }).split("\u0000");
  const [providerBefore, providerAfter] = formatOperatorCopy(copy.chatProvider, { privacy: "\u0000" }).split("\u0000");
  const privacy = privacyAvailable ? <Link to="/privacy" className="underline">{m.village_chat_consent_privacy_link()}</Link> : m.village_chat_consent_privacy_link();
  return <section aria-labelledby="chat-consent-title" className="space-y-3">
    <h2 id="chat-consent-title" className="text-lg font-semibold">{m.village_chat_consent_title()}</h2>
    {changes.length > 0 && <section aria-labelledby="chat-consent-changes" className="space-y-2">
      <h3 id="chat-consent-changes" className="font-semibold">{m.village_chat_changes_title()}</h3>
      <ul className="list-disc space-y-2 pl-6 ui-meta">{changes.map(point => <li key={point}>{point}</li>)}</ul>
    </section>}
    <ul className="list-disc space-y-2 pl-6">
      <li>{m.village_chat_summary_readers()}</li>
      <li>{m.village_chat_summary_translation()}</li>
      <li>{m.village_chat_summary_reports()}</li>
    </ul>
    <details className="space-y-3">
      <summary className="cursor-pointer underline">{m.village_chat_read_full()}</summary>
      <ul className="list-disc space-y-3 pl-6">
        <li>{m.village_chat_consent_readers()}</li>
        <li><span>{m.village_chat_consent_translation({ count: CHAT_TRANSLATION_CONTEXT_COUNT })}</span> <span>{m.chat_consent_reply_translation()}</span></li>
        <li>{providerBefore}{privacy}{providerAfter}</li>
        <li><span>{m.village_chat_consent_review({ count: CHAT_CASE_CONTEXT_COUNT * (1 + CHAT_CASE_EXPAND_LIMIT) })}</span> <span>{m.chat_consent_reply_review()}</span></li>
        <li>{m.village_chat_consent_ai_review()}</li>
        <li>{m.chat_consent_nushi()} {privacy}</li>
        <li>{m.chat_consent_nushi_hide()}</li>
        <li>{m.village_chat_consent_spam()}</li>
        <li>{m.village_chat_consent_retention({ days: CHAT_REPORT_RETAIN_DAYS })}</li>
        <li>{ownBefore}<Link to="/settings/chat" className="underline">{m.village_chat_own_title()}</Link>{ownAfter}</li>
        <li>{m.village_chat_consent_decline()}</li>
        {privacyAvailable && <li>{privacyBefore}<Link to="/privacy" className="underline">{m.village_chat_consent_privacy_link()}</Link>{privacyAfter}</li>}
      </ul>
    </details>
  </section>;
}
