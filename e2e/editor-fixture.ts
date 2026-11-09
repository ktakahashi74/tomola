import { test as base, type Browser } from "@playwright/test";
import { EDITOR_MODE_STORAGE_KEY } from "../app/lib/rich-editor";

// All ordinary development/production suites use `test`: their subject is
// independent of the editor mode, including contexts created in beforeAll.
// Only rich-editor*.spec.ts and editor-default.spec.ts use `richEditorTest`
// (the production helper extends both variants with its dynamic baseURL).
export const richEditorTest = base;
export const test = base.extend<{}, { browser: Browser }>({
  browser: [async ({ browser }, use) => {
    const prepared = new Proxy(browser, {
      get(target, property) {
        if (property === "newContext") return async (...args: Parameters<Browser["newContext"]>) => {
          const context = await target.newContext(...args);
          await context.addInitScript(key => {
            try {
              if (localStorage.getItem(key) === null) localStorage.setItem(key, "markdown");
            } catch { /* No storage on some browser documents. */ }
          }, EDITOR_MODE_STORAGE_KEY);
          return context;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await use(prepared);
  }, { scope: "worker" }],
});
