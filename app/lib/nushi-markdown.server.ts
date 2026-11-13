import type { Db } from "./db/client.server";
import { readNushiAnswer, threadNushi } from "./nushi.server";
import type { Lang } from "./languages";
import { mdBlock } from "./md/frontmatter.server";

export function nushiBody(value: NonNullable<Awaited<ReturnType<typeof readNushiAnswer>>>) {
  if (value.hidden) return "AI (Nushi) answer — currently not displayed.";
  const lines = ["AI (Nushi) answer", `Called by @${value.caller ?? "?"}. From this village’s public posts.`];
  if (value.personal) lines.push("This is not the owner's answer. The owner has not checked it.");
  if (value.answer.status === "not_confirmed") lines.push(value.originalLang === "ja" ? "今回参照した投稿では見つかりませんでした。人のいまの考えや新しい同意は、その人への返信かメンションで聞いてください。" : "Not found in the posts consulted this time. Ask the person by reply or mention about current views or a new agreement.");
  for (const reading of value.answer.readings) lines.push(`${reading.text} ${reading.citations.map(index => `[${index}]`).join(" ")}`);
  value.answer.citations.forEach((citation, index) => {
    const label = value.labels.find(source => source.id === Number(/^e-(\d+)-/.exec(citation.sourceId)![1]));
    lines.push(`[${index + 1}] ${citation.author} · ${label?.date.slice(0, 10) ?? ""}${label?.left ? " · author has left this village" : ""}`, `> ${citation.original.quote.replace(/\n/g, "\n> ")}\n${citation.original.href}`);
    if (citation.translation) lines.push(`> ${citation.translation.quote.replace(/\n/g, "\n> ")}\n${citation.translation.href}`);
  });
  lines.push(`Consulted: ${value.scope.posts} posts · ${value.scope.from ?? "—"}–${value.scope.to ?? "—"}.`, `/search?village=${encodeURIComponent(value.villageSlug ?? value.villageId)}`, `/ai-use#nushi · ${value.model} · ${value.promptVersion}`, "/principles#s6");
  return lines.join("\n\n");
}
export async function nushiMarkdownBlocks(db: Db, threadId: number, entryIds: number[], language: Lang) {
  const view = await threadNushi(db, threadId, entryIds, language);
  return view.answers.map(value => mdBlock({ type: "ai_reply", id: `nushi-${value.id}`, author_kind: "ai", author: "Nushi", thread: `p-${threadId}`, reply_to: `${value.entryId === threadId ? "p" : "c"}-${value.entryId}`, canonical: `/nushi/${value.id}`, hidden: value.hidden || undefined, content_trust: "untrusted_ai_content" }, value.hidden ? null : nushiBody(value)));
}
