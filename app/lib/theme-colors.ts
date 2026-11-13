// Browser chrome and the standalone offline document share these page grounds.
export const THEME_COLORS = { light: "#fbfaf7", dark: "#1a1917" } as const;
export type ColorScheme = keyof typeof THEME_COLORS;
export const isColorScheme = (value: unknown): value is ColorScheme => value === "light" || value === "dark";
