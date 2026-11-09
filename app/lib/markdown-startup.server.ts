import { initializeMarkdown, withMarkdownScope, type MarkdownExecutorOptions } from "./markdown-budget.server";
import { initializePrinciplesMarkdown } from "./principles.server";
import { initializeWhyMarkdown } from "./why.server";
import { initializeNameMarkdown } from "./name.server";

let prepared: Promise<void> | undefined;
// Production calls this before listening; development calls the same explicit
// startup step before routing. Importing these modules has no worker effects.
export function initializeSiteMarkdown(options?: MarkdownExecutorOptions): Promise<void> {
  return prepared ??= (async () => {
    // A local test preload can provide a controlled worker without exposing a
    // fixture HTTP endpoint. Real production processes ignore this injection.
    const test = globalThis as typeof globalThis & { __tomolaMarkdownTestOptions?: MarkdownExecutorOptions };
    const fakeRuntime = process.env.TOMOLA_ALLOW_FAKE_ENGINES === "1" || (process.env.NODE_ENV !== "production" && process.env.TRANSLATION_PRIMARY === "fake" && process.env.EMBEDDING_ENGINE === "fake");
    await initializeMarkdown(fakeRuntime && test.__tomolaMarkdownTestOptions ? { ...options, ...test.__tomolaMarkdownTestOptions } : options);
    await withMarkdownScope("background", undefined, async () => {
      await initializePrinciplesMarkdown();
      await initializeWhyMarkdown();
      await initializeNameMarkdown();
    });
  })();
}
