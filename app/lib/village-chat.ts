import { mentionCandidates } from "./mention-syntax";

export const CHAT_BODY_MAX = 2000;
export const CHAT_TRANSLATION_CONTEXT_COUNT = 2;
export class ChatError extends Error {
  constructor(public code: "not_found" | "forbidden" | "ended" | "invalid") { super(code); }
}
export type ChatPart = { type: "text"; text: string } | { type: "link"; text: string; href: string } | { type: "mention"; text: string; href: string };
export type ChatMentionTarget = { prefix: string; href: string };
export type ChatTopicCard = { id: number; title: string; lang: string; fromBody: boolean; replyCount: number; href: string; replyHref: string };
export type ChatTranslation = { text: string | null; lang: string; state: "pending" | "ready" | "failed" | "paused"; errorCode?: string | null };
export type ActiveChatMessage = {
  id: string; author: string; authorName?: string | null; avatarUrl?: string | null; own: boolean; lang: string; parts: ChatPart[];
  createdSeq: number; changedSeq: number; createdAt: string;
  edited: boolean; deleted: false; hidden: boolean;
  topics?: ChatTopicCard[];
  translation: ChatTranslation | null;
};
export type DeletedChatMessage = {
  id: string; createdSeq: number; changedSeq: number; deleted: true;
  author?: never; own?: never; lang?: never; parts?: never; createdAt?: never; edited?: never; hidden?: never;
  topics?: never;
  translation?: never;
};
export type ChatMessage = ActiveChatMessage | DeletedChatMessage;

function trimLink(raw: string): string {
  let href = raw.replace(/[.,;:!?\[\]}'\\]+$/, "");
  let extra = (href.match(/\)/g)?.length ?? 0) - (href.match(/\(/g)?.length ?? 0);
  while (extra > 0 && href.endsWith(")")) {
    href = href.slice(0, -1).replace(/[.,;:!?\[\]}'\\]+$/, "");
    extra--;
  }
  return href;
}

// URLs end before non-ASCII prose. Never render supplied markup or fetch a URL.
export function chatParts(body: string, targets?: ReadonlyMap<string, ChatMentionTarget>): ChatPart[] {
  const parts: ChatPart[] = [];
  let from = 0;
  for (const match of body.matchAll(/https?:\/\/[\x21-\x7e]+/g)) {
    const raw = match[0].split(/[<>"`]/, 1)[0];
    const href = trimLink(raw);
    try { const url = new URL(href); if (!url.hostname || !["http:", "https:"].includes(url.protocol)) continue; } catch { continue; }
    const start = match.index!;
    if (start > from) parts.push({ type: "text", text: body.slice(from, start) });
    parts.push({ type: "link", text: href, href });
    from = start + href.length;
  }
  if (from < body.length) parts.push({ type: "text", text: body.slice(from) });
  if (!targets?.size) return parts;
  return parts.flatMap(part => {
    if (part.type !== "text") return [part];
    const rendered: ChatPart[] = [];
    let from = 0;
    for (const candidate of mentionCandidates(part.text)) {
      const target = targets.get(part.text.slice(candidate.start, candidate.end));
      if (!target) continue;
      if (candidate.start > from) rendered.push({ type: "text", text: part.text.slice(from, candidate.start) });
      const end = candidate.start + 1 + target.prefix.length;
      rendered.push({ type: "mention", text: part.text.slice(candidate.start, end), href: target.href });
      from = end;
    }
    if (from < part.text.length) rendered.push({ type: "text", text: part.text.slice(from) });
    return rendered;
  });
}

export function chatSequence(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
