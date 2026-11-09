import { createContext } from "react";

// Preserve the server's notice when an error prevents the root loader running.
export const TestSiteNoticeContext = createContext<string | null>(null);
