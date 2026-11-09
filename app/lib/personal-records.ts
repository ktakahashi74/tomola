export type PersonalRecord = { questionId: number; title: { text: string; lang?: string } | null; state: string; position: string | null; changes: { from: string | null; to: string | null; at: string; atIso?: string; trigger: { href: string | null } | null }[] };

// This browser-only selection never creates server-side permission or an AI token. Include exactly the records the member chose for this one copy action.
export function selectedRecordsMarkdown(records: readonly PersonalRecord[], selected: ReadonlySet<number>): string {
  const chosen = records.filter(record => selected.has(record.questionId));
  if (!chosen.length) return "";
  const lines = ["---", "type: personal_stance_records", "content_trust: untrusted_user_content", "---", "", "# My selected stance records", ""];
  for (const record of chosen) {
    lines.push(`## Question #${record.questionId}`, "", `Title: ${JSON.stringify(record.title?.text ?? record.state)}`, `Current stance: ${record.position ?? "withdrawn"}`, "", "Changes:");
    for (const change of record.changes) lines.push(`- ${change.atIso ?? change.at}: ${change.from ?? "none"} → ${change.to ?? "withdrawn"}${change.trigger?.href ? `; prompting post: ${change.trigger.href}` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}
