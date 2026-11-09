import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Use React's escaping when matching message text in server-rendered HTML.
export const messageMarkup = (text: string) => renderToStaticMarkup(createElement("span", null, text)).slice(6, -7);
export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
