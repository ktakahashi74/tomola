import type { GlossaryHint } from "~/lib/llm/types";
import { KEEP_TERMS } from "./messages";

// Glossary for interface-message translation (pnpm i18n:translate), using the GlossaryHint shape that entry translation gets from the operator-managed DB glossary:
// supply recommended translations without requiring use when unsuitable for context. This small fixed-interface vocabulary table prevents inconsistent wording. Do not use the DB table, initially empty,
// because interface translation should remain within the repository. Missing keepOriginal terms also fail validateMessage and trigger retries.
const keep = (term: string): GlossaryHint => ({ term, candidates: [], keepOriginal: true });

type Row = { term: string; note: string; by: Partial<Record<string, string[]>> };
const rows: Row[] = [
  { term: "AI", note: "artificial intelligence", by: { fr: ["IA"], de: ["KI"], "zh-Hans": ["AI"], "zh-Hant": ["AI"], ko: ["AI"], th: ["AI"], vi: ["AI"] } },
  {
    term: "passkey",
    note: "WebAuthn credential (the log-in method that replaces a password)",
    by: { fr: ["clé d'accès"], de: ["Passkey"], "zh-Hans": ["通行密钥"], "zh-Hant": ["通行密鑰"], ko: ["패스키"], th: ["พาสคีย์"], vi: ["khóa truy cập (passkey)"] },
  },
  { term: "topic", note: "the opening post of a thread (not a 'subject' line, not a category)", by: { fr: ["sujet"], de: ["Thema"], "zh-Hans": ["话题"], "zh-Hant": ["話題"], ko: ["주제"], th: ["หัวข้อ"], vi: ["chủ đề"] } },
  { term: "reply", note: "a post in answer to a topic or to another reply", by: { fr: ["réponse"], de: ["Antwort"], "zh-Hans": ["回复"], "zh-Hant": ["回覆"], ko: ["답글"], th: ["ตอบกลับ"], vi: ["trả lời"] } },
  {
    term: "home language area",
    note: "the language community a member belongs to; it is used to count from how many languages their Insightful reactions and stances come (never shown per language)",
    by: { fr: ["espace linguistique d'origine"], de: ["Heimat-Sprachraum"] },
  },
  {
    term: "Insightful",
    note:
      "the one-tap reaction on a post (Japanese: なるほど): 'I gained a new perspective from this post'. It is NOT a vote, a like or agreement: do not translate it as agree, like, upvote or vote. " +
      "A short phrase that fits a button and a count ('Insightful 9 (3 languages)'). The items are 'Insightful reactions' and the number is 'the Insightful count'; use the same word for the reaction " +
      "everywhere (button, count, settings, notices). Candidates are provisional until a native speaker has checked them.",
    by: { fr: ["Éclairant"], de: ["Aufschlussreich"], "zh-Hans": ["有启发"], "zh-Hant": ["有啟發"], ko: ["새로운 시각"], th: ["ได้มุมมองใหม่"], vi: ["Có góc nhìn mới"] },
  },
  { term: "original", note: "the text as its author wrote it (as opposed to a translation)", by: { fr: ["original"], de: ["Original"], "zh-Hans": ["原文"], "zh-Hant": ["原文"], ko: ["원문"], th: ["ต้นฉบับ"], vi: ["bản gốc"] } },
  { term: "divergence", note: "a place where two independent machine translations of a sentence differ in meaning", by: { fr: ["divergence"], de: ["Abweichung"], "zh-Hans": ["分歧"], "zh-Hant": ["分歧"], ko: ["불일치"], th: ["ความแตกต่าง"], vi: ["chênh lệch"] } },
  {
    term: "cosine distance",
    note: "the distance between two embedding vectors (1 minus the cosine similarity); write the whole word in the target language only",
    by: { fr: ["distance cosinus"], de: ["Kosinusdistanz"], "zh-Hans": ["余弦距离"], "zh-Hant": ["餘弦距離"], ko: ["코사인 거리"], th: ["ระยะห่างโคไซน์"], vi: ["khoảng cách cosine"] },
  },
  { term: "moderator", note: "a member who handles reports for a language", by: { fr: ["modérateur"], de: ["Moderator"], "zh-Hans": ["版主"], "zh-Hant": ["版主"], ko: ["모더레이터"], th: ["ผู้ดูแล"], vi: ["người điều hành"] } },
  { term: "operator", note: "the organization that runs the site (not a moderator)", by: { ko: ["운영자"] } },
  { term: "village", note: "a community space on the site that members create, join and leave", by: { ko: ["빌리지"] } },
  { term: "stance", note: "a member's position on a question, counted without names (agree, disagree or neither); use the same word everywhere", by: { fr: ["position"], de: ["Position"], "zh-Hans": ["立场"], "zh-Hant": ["立場"], ko: ["입장"], th: ["จุดยืน"], vi: ["lập trường"] } },
  { term: "Agree", note: "a stance option on a question", by: { fr: ["D'accord"], de: ["Stimme zu"], "zh-Hans": ["赞成"], "zh-Hant": ["贊成"], ko: ["찬성"], th: ["เห็นด้วย"], vi: ["Đồng ý"] } },
  { term: "Disagree", note: "a stance option on a question", by: { fr: ["Pas d'accord"], de: ["Stimme nicht zu"], "zh-Hans": ["反对"], "zh-Hant": ["反對"], ko: ["반대"], th: ["ไม่เห็นด้วย"], vi: ["Không đồng ý"] } },
  {
    term: "Neither",
    note: "a stance option on a question: the member cannot say either agree or disagree. It is NOT 'neutral', 'no opinion' or 'abstain'; use the same phrase for the option and for the mark on replies",
    by: { fr: ["Ni l'un ni l'autre"], de: ["Weder noch"], "zh-Hans": ["难以判断"], "zh-Hant": ["難以判斷"], ko: ["어느 쪽도 아님"], th: ["ไม่ทั้งสองอย่าง"], vi: ["Không bên nào"] },
  },
  { term: "question", note: "a post that asks readers for their stance (a kind of topic), not an ordinary interrogative sentence", by: { fr: ["question"], de: ["Frage"], "zh-Hans": ["问题"], "zh-Hant": ["問題"], ko: ["질문"], th: ["คำถาม"], vi: ["câu hỏi"] } },
  { term: "post", note: "a topic or a reply (the general word for both)", by: { fr: ["publication"], de: ["Beitrag"], "zh-Hans": ["帖子"], "zh-Hant": ["貼文"], ko: ["게시물"], th: ["โพสต์"], vi: ["bài đăng"] } },
];

// Glossary for locale: keepOriginal entries plus recommended translations for that language.
export function glossaryFor(locale: string): GlossaryHint[] {
  return [
    ...KEEP_TERMS.map(keep),
    ...rows.flatMap((r): GlossaryHint[] => {
      const candidates = r.by[locale];
      return candidates ? [{ term: r.term, candidates, note: r.note }] : [];
    }),
  ];
}
