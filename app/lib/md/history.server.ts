import { readEntryHistory } from "../entry-history.server";
import type { Db } from "../db/client.server";
import { joinBlocks, mdBlock } from "./frontmatter.server";
import { mdUrl, siteUrl, twinPreamble } from "./urls.server";
import { historyDiff } from "../history-diff.server";

export async function buildHistoryMarkdown(db: Db, id: number, version: string | undefined, readerId: string | null, k: string | null, expectedKind?: "topic" | "reply"): Promise<string | null> {
  const history = await readEntryHistory(db, id, readerId, version);
  if (!history || expectedKind && history.kind !== expectedKind) return null;
  const link = (v: string) => mdUrl(`${history.path}/${v}.md`, { k, lang: null });
  if (version === undefined) return mdBlock({ type: "revision_index", content_trust: "untrusted_user_content", entry_id: id, canonical: siteUrl(history.path),
    versions: history.versions.map((v, i) => ({ id: v.id, timestamp: v.at, event: i === 0 ? "posted" : "updated", current: v.current, deleted: v.deleted, md: link(v.id) })),
  }, "", { preamble: twinPreamble() });
  const selected = history.versions.find(v => v.id === version)!;
  const original = mdBlock({ type: "revision", content_trust: "untrusted_user_content", entry_id: id, revision: version, timestamp: selected.at, current: selected.current, deleted: selected.deleted,
    ...(history.selected ? { title: history.selected.title } : {}), canonical: siteUrl(`${history.path}/${version}`),
  }, history.selected?.body ?? "", { preamble: twinPreamble() });
  const previous = history.selected?.previous;
  if (!history.selected || !previous) return original;
  return joinBlocks([original, mdBlock({ type: "revision_diff", content_trust: "untrusted_user_content", title: historyDiff(previous.title ?? "", history.selected.title ?? "").map(c => ({ ...c })),
    body: historyDiff(previous.body, history.selected.body).map(c => ({ ...c })),
  }, "")]);
}
