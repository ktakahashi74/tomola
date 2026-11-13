import { defineConfig } from "vitest/config";
import base from "../vitest.config.ts";

if (process.env.TOMOLA_TEST_PG !== "1") {
  throw new Error("Chat search performance measurements require TOMOLA_TEST_PG=1 and a dedicated TEST_DATABASE_URL");
}

export default defineConfig({
  ...base,
  test: { ...base.test, include: ["scripts/chat-search-performance.test.ts"] },
});
