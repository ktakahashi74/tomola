// Production executes the compiled worker; development keeps source loading.
if (process.env.NODE_ENV === "production") {
  await import("../build/markdown/markdown-worker.mjs");
} else {
  await import("./markdown-operations.mjs");
  await import("./markdown-worker-runtime.mjs");
}
