import { expect, it, vi } from "vitest";
import { assertFigureFontsAvailable, canRenderFigureText, createFontCoverageLookup, FigureFontUnavailableError, parseFontCoverage, type FigureFontWeight } from "~/lib/figure-fonts.server";

it("rejects fallback families, other faces and invalid charset data", () => {
  expect(parseFontCoverage("Noto Sans\n/fonts/NotoSans-Regular.ttf\n20-7e 100-1ff\n", "Noto Sans")).toEqual([[32, 126], [256, 511]]);
  expect(parseFontCoverage("DejaVu Sans\n/fonts/DejaVuSans.ttf\n20-ffff\n", "Noto Sans")).toBeNull();
  expect(parseFontCoverage("Noto Sans\n/fonts/NotoSans-Bold.ttf\n20-ffff\n", "Noto Sans")).toBeNull();
  for (const charset of ["", "xyz", "100-20", "0-110000"]) expect(parseFontCoverage(`Noto Sans\n/fonts/NotoSans-Regular.ttf\n${charset}\n`, "Noto Sans")).toBeNull();
});

it.each([
  ["Noto Sans", "NotoSans"], ["Noto Sans Thai", "NotoSansThai"],
  ...["JP", "KR", "SC", "TC"].map(region => [`Noto Sans CJK ${region}`, "NotoSansCJK"]),
])("accepts only the requested weight for %s", (family, file) => {
  const extension = file === "NotoSansCJK" ? "ttc" : "ttf";
  for (const weight of ["normal", "bold"] as const) {
    for (const face of ["Regular", "Bold"]) {
      const output = `${family}\n/fonts/${file}-${face}.${extension}\n20-7e\n`;
      expect(parseFontCoverage(output, family, weight)).toEqual((weight === "bold") === (face === "Bold") ? [[32, 126]] : null);
    }
  }
});

it("keeps weight-specific caches and retries a missing bold face even after regular succeeds", async () => {
  const regular = [[32, 126]] as const, bold = [[32, 100]] as const;
  let present = false;
  const probe = vi.fn(async (_family: string, weight: FigureFontWeight) => weight === "normal" ? regular : present ? bold : null);
  const lookup = createFontCoverageLookup(probe);
  expect(await lookup("Noto Sans", "normal")).toBe(regular);
  await expect(lookup("Noto Sans", "bold")).rejects.toMatchObject({ retryable: true });
  present = true;
  expect(await lookup("Noto Sans", "bold")).toBe(bold);
  expect(await lookup("Noto Sans", "normal")).toBe(regular);
  expect(await lookup("Noto Sans", "bold")).toBe(bold);
  expect(probe).toHaveBeenCalledTimes(3);
});

it("requires both weights in preflight and never borrows regular coverage for bold text", async () => {
  const lookup = vi.fn(async (_family: string, weight: FigureFontWeight) => weight === "normal" ? [[32, 126], [0x4e00, 0x9fff]] as const : [[32, 126]] as const);
  expect(await canRenderFigureText(["漢字"], "ja", lookup, "normal")).toBe(true);
  expect(await canRenderFigureText(["漢字"], "ja", lookup, "bold")).toBe(false);
  const missing = createFontCoverageLookup(async (_family, weight) => weight === "bold" ? null : [[32, 126]]);
  await expect(assertFigureFontsAvailable("en", missing)).rejects.toMatchObject({ retryable: true });
  await expect(canRenderFigureText(["ASCII"], "en", missing, "bold")).rejects.toBeInstanceOf(FigureFontUnavailableError);
});

it("requires the primary font and covers every visible code point with bundled fallbacks", async () => {
  const lookup = async (family: string) => family === "Noto Sans" ? [[32, 126]] as const : family === "Noto Sans Thai" ? [[0xe00, 0xe7f]] as const : [[0x4e00, 0x9fff]] as const;
  expect(await canRenderFigureText(["ASCII\n漢字 ไทย"], "en", lookup)).toBe(true);
  expect(await canRenderFigureText(["Unknown \u0378"], "en", lookup)).toBe(false);
  expect(await canRenderFigureText(["\u200d"], "en", lookup)).toBe(false);
  await expect(canRenderFigureText(["ASCII"], "ja", async family => family === "Noto Sans" ? [[32, 126]] : null)).rejects.toBeInstanceOf(FigureFontUnavailableError);
});

it.each(["timeout", "spawn", "missing"])("does not cache a %s probe failure and caches a later success", async mode => {
  const coverage = [[32, 126]] as const;
  const probe = vi.fn<NonNullable<Parameters<typeof createFontCoverageLookup>[0]>>().mockResolvedValue(coverage);
  if (mode === "missing") probe.mockResolvedValueOnce(null);
  else probe.mockRejectedValueOnce(Object.assign(new Error(mode), { code: mode === "spawn" ? "ENOENT" : "ETIMEDOUT" }));
  const lookup = createFontCoverageLookup(probe);
  await expect(lookup("Noto Sans")).rejects.toBeInstanceOf(FigureFontUnavailableError);
  expect(await lookup("Noto Sans")).toBe(coverage);
  expect(await lookup("Noto Sans")).toBe(coverage);
  expect(probe).toHaveBeenCalledTimes(2);
});

it("requires all three bundled files before declaring a code point unsupported", async () => {
  const lookup = vi.fn(async (family: string) => family === "Noto Sans Thai" ? null : [[32, 126]] as const);
  await expect(assertFigureFontsAvailable("en", lookup)).rejects.toBeInstanceOf(FigureFontUnavailableError);
  await expect(canRenderFigureText(["\u0378"], "en", lookup)).rejects.toBeInstanceOf(FigureFontUnavailableError);
});
