import type { DisplayNames } from "../display-names";
import { selectDisplayName } from "../display-names.server";
import { INVITATION_TTL_DAYS } from "../invitations.server";
import { operatorConfig } from "../operator-config.server";
import type { Locale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import type { MailMessage } from "./mail.server";

// This introduces the invitation; signup verification uses separate mail keys.
export function signupInvitationMail(input: {
  to: string; url: string; locale: Locale; sender: DisplayNames & { handle: string; homeArea: string }; note: string; village: string | null;
}): MailMessage {
  const options = { locale: input.locale };
  const name = selectDisplayName(input.sender, input.locale) ?? `@${input.sender.handle}`;
  return {
    to: input.to, locale: input.locale, sensitive: true,
    subject: m.mail_signup_invitation_subject({ name }, options),
    text: [
      m.mail_signup_invitation_intro({ name, handle: input.sender.handle }, options),
      m.mail_signup_invitation_about({}, options),
      ...(input.note ? [m.mail_signup_invitation_note({ name, note: input.note }, options)] : []),
      m.mail_signup_invitation_link({ days: INVITATION_TTL_DAYS, url: input.url }, options),
      ...(input.village ? [m.mail_signup_invitation_village({ village: input.village }, options)] : []),
      m.mail_signup_invitation_ignore({}, options),
      m.mail_signup_invitation_contact({ contact: operatorConfig().contactEmail }, options),
    ].join("\n\n"),
  };
}
