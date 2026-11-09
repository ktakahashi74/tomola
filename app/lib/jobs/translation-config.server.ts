export const TRANSLATION_JOB_KINDS = ["translate_entry", "translate_title", "measure_divergence", "retranslate_after_report", "translate_village", "translate_invitation_note", "prepare_figures", "read_figure", "translate_figure"] as const;

export function translationConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRANSLATION_CONCURRENCY?.trim() || "2";
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > 8) throw new Error("TRANSLATION_CONCURRENCY must be an integer from 1 to 8");
  return n;
}
