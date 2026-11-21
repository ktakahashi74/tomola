export function formatArticleReadingDisplay(total: number, translated: number) {
  if (total < 5) return null;
  const original = total - translated;
  return { total, translated: translated >= 5 && (original === 0 || original >= 5) ? translated : null };
}
