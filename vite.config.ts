import { serviceWorkerBuild } from "./scripts/service-worker-build.ts";
import { publicImageVersions } from "./scripts/public-image-versions.ts";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { cn } from "cn/vite";
import { cnBuildOptions } from "./scripts/cn-build.ts";
import { fileURLToPath } from "node:url";

// Local development always uses a fictional operator unless explicitly set.
if (process.env.NODE_ENV !== "production" && !process.env.TOMOLA_OPERATOR_DIR) {
  process.env.TOMOLA_OPERATOR_DIR = fileURLToPath(new URL("./tests/fixtures/operator", import.meta.url));
}

export default defineConfig({
  plugins: [
    cn(cnBuildOptions),
    serviceWorkerBuild(),
    publicImageVersions(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./app/paraglide",
      emitTsDeclarations: true,
      // custom-htmlLang: the server decides the interface language and renders it in <html lang>; the browser reads that (app/lib/http/locale-strategy.ts, locale.server.ts).
      strategy: ["custom-htmlLang", "baseLocale"],
    }),
    tailwindcss(),
    reactRouter(),
  ],
  // The development server for e2e browser tests uses a dedicated dependency-optimization cache (e2e/global-setup.ts).
  cacheDir: process.env.TOMOLA_VITE_CACHE_DIR || undefined,
  // If port 5173 is occupied, Vite silently switches to 5174, conflicting with BETTER_AUTH_URL and causing every login to fail origin checks.
  server: { strictPort: true },
  resolve: {
    tsconfigPaths: true,
  },
  optimizeDeps: {
    exclude: ["@electric-sql/pglite"],
    // Dependencies discovered after the first page load, when opening passkey buttons or front-matter paste forms.
    // Optimize these at development-server startup; otherwise later discovery triggers reoptimization and a page reload, erasing form input during tests.
    include: [
      "@better-auth/passkey/client", "better-auth/client", "yaml",
      // Compose and member navigation discover these after the login page.
      // Include them before a cold browser load can acquire obsolete dep URLs.
      "@base-ui/react/menu", "@base-ui/react/merge-props", "@base-ui/react/radio-group",
      "@base-ui/react/radio", "@base-ui/react/tooltip", "@base-ui/react/use-render", "@base-ui/react/checkbox",
      "@simplewebauthn/server",
      // The route crawl also encounters server imports before stripping them
      // from client routes. Reserve the observed entries in the same batch.
      "@anthropic-ai/sdk", "@base-ui/react/button", "@base-ui/react/dialog", "@base-ui/react/input", "@base-ui/react/select", "@base-ui/react/separator",
      "@better-auth/cimd", "@better-auth/cimd/node", "@better-auth/drizzle-adapter", "@better-auth/mcp", "@better-auth/oauth-provider", "@better-auth/passkey",
      "@electric-sql/pglite-pgvector", "@google/genai", "@simplewebauthn/browser", "better-auth", "better-auth/api", "better-auth/cookies", "better-auth/plugins",
      "class-variance-authority", "cn/engine", "drizzle-orm", "drizzle-orm/node-postgres", "drizzle-orm/node-postgres/migrator", "drizzle-orm/pg-core", "drizzle-orm/pglite", "drizzle-orm/pglite/migrator",
      "lucide-react", "nodemailer", "pg", "rehype-katex", "rehype-sanitize", "rehype-stringify", "remark-gfm", "remark-math", "remark-parse", "remark-rehype", "unified", "zod",
      // Pre-optimize the optional editor without loading it in the browser.
      // Discovering these on the first mode switch would reload the draft.
      "@milkdown/kit/core", "@milkdown/kit/preset/commonmark", "@milkdown/kit/preset/gfm",
      "@milkdown/kit/plugin/clipboard", "@milkdown/kit/plugin/history", "@milkdown/kit/utils",
      "@milkdown/kit/prose/state", "@milkdown/kit/prose/view", "@milkdown/kit/prose/model", "@milkdown/kit/prose/commands", "@milkdown/kit/prose/schema-list", "@milkdown/kit/prose/history",
      "@milkdown/kit/prose", "@milkdown/kit/prose/inputrules", "remark-cjk-friendly", "remark-cjk-friendly-gfm-strikethrough",
      "mdast-util-gfm-autolink-literal", "mdast-util-gfm-footnote", "mdast-util-gfm-strikethrough", "mdast-util-gfm-table", "mdast-util-gfm-task-list-item",
      "micromark-extension-gfm-footnote", "micromark-extension-gfm-strikethrough", "micromark-extension-gfm-table", "micromark-extension-gfm-task-list-item",
    ],
  },
});
