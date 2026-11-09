import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
register({ tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)) });
export const { markdownOperations, warmMarkdownWorker } = await import("./markdown-operations-core.mjs");
