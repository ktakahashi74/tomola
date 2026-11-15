export const NUSHI_VOICE_MAX = 500;
export const NUSHI_VOICE_ANCHOR = "nushi-voice";

export function nushiVoiceHref(slug: string, eventId?: number | null) {
  const path = slug.startsWith("@") ? `/v/personal/${encodeURIComponent(slug.slice(1))}` : `/v/${encodeURIComponent(slug)}`;
  return `${path}#${NUSHI_VOICE_ANCHOR}${eventId ? `-${eventId}` : ""}`;
}
