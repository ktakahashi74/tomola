// Keep development, production and unit tests on the same generated merge table.
export const cnBuildOptions = {
  content: ["app/**/*.{js,jsx,ts,tsx}"],
  // Match the existing default merger: registering theme animations would
  // start merging classes it previously left unchanged.
  css: false as const,
  out: "app/lib/cn-tables.generated.mjs",
};
