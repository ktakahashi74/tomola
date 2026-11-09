import { renderFigureLabels } from "~/lib/figure-render.server";

// Raster-only assertions use the image; outcome assertions call the renderer directly.
export const renderFigure = async (...args: Parameters<typeof renderFigureLabels>) => (await renderFigureLabels(...args)).bytes;
