import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

import type { LanguageDecision } from "~/lib/lang-detect";
import type { PublicVillage } from "~/lib/villages.server";

export type SigningOperation = "create-topic" | "create-reply" | "publish-draft" | "edit-topic" | "edit-reply" | "change-handle" | "change-display-name" | "remove-passkey" | "change-signing-preference" | "delete-account";
export type SigningContent = { title: string | null; body: string; lang: string | null };
export type SigningPreview = {
  village?: PublicVillage;
  operation: SigningOperation;
  payloadHash: string;
  content: SigningContent;
  language: LanguageDecision | null;
  viewed: SigningContent | null;
  current: SigningContent | null;
  target: { threadId: number | null; parentId: number | null; entryId: number | null; draftId: number | null; altOf: number | null; villageId?: string };
  lastEditor: { id: string | null; name: string | null; uri: string | null; at: string | null } | null;
  targetContext: { thread: SigningContent | null; parent: SigningContent | null };
  enrolled: boolean;
  signatureRequired: boolean;
};
export type SigningProof = { challenge: string; assertion: AuthenticationResponseJSON };
export type SigningOptions = { challenge: string; options: PublicKeyCredentialRequestOptionsJSON };
export const SIGNATURE_CHALLENGE_FIELD = "signatureChallenge";
export const SIGNATURE_ASSERTION_FIELD = "signatureAssertion";
export const SIGNING_VIEW_FIELD = "signingView";
