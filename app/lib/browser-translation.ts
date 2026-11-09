import { createContext } from "react";

// The server decides once per document. The client reads the rendered <html translate> before hydration and keeps that decision until a reload.
export const BrowserTranslationContext = createContext(false);
