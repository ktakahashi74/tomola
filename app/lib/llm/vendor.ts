// Map engine names to providers for observations to distinguish primary/secondary comparisons using the same company (not independent),
// using the primary/secondary translation engine columns of divergence records.
// gemini means Google, claude Anthropic. Fake engines share provider fake for development/tests. Unknown names are their own providers.
export function vendorOf(engine: string | null | undefined): string | null {
  if (!engine) return null;
  switch (engine) {
    case "gemini":
      return "google";
    case "claude":
      return "anthropic";
    default:
      return engine;
  }
}

// Whether primary and secondary share a provider; null if either is unknown, since neither equality nor difference is established.
export function sameVendor(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const va = vendorOf(a);
  const vb = vendorOf(b);
  return va === null || vb === null ? null : va === vb;
}
