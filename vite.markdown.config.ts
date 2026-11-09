import { defineConfig } from "vite";

// Build the same worker runtime used in development, without its tsx loader.
export default defineConfig({
  publicDir: false,
  resolve: { tsconfigPaths: true },
  build: {
    ssr: "server/markdown-worker-runtime.mjs",
    outDir: "build/markdown",
    target: "node26",
    rolldownOptions: { output: { entryFileNames: "markdown-worker.mjs", codeSplitting: false } },
  },
});
