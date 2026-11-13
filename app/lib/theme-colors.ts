export const COLOR_SCHEMES = ["light", "dark"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];
// Browser chrome and the standalone offline document share these page grounds.
export const THEME_COLORS = { light: "#fbfaf7", dark: "#1a1917" } as const satisfies Record<ColorScheme, string>;
export const isColorScheme = (value: unknown): value is ColorScheme => COLOR_SCHEMES.some(scheme => scheme === value);
