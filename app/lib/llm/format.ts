// Display helper, also used in browsers: format microdollars (millionths of USD) as `$0.0123`.
export function formatUsdMicro(micro: number, digits = 4): string {
  return `$${(micro / 1_000_000).toFixed(digits)}`;
}
