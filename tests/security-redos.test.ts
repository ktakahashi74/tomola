import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// A synchronous regression must fail in a disposable process instead of hanging
// Vitest or the application's event loop. Exercise the complete structure check.
it("handles maximum-length unmatched backtick runs within a hard process deadline", async () => {
  const code = `
    import { createMarkdownExecutor, setMarkdownExecutorForTests, stopMarkdown } from './app/lib/markdown-budget.server.ts';
    await setMarkdownExecutorForTests(createMarkdownExecutor({cpuMs: 1000}));
    import { countStructure, proseOf, checkStructure } from './app/lib/llm/structure.server.ts';
    const results = [];
    for (const text of ['x' + '\\x60'.repeat(49999), '<!--' + '\\x60'.repeat(49993) + '-->']) {
      results.push({ counts: await countStructure(text), proseLength: (await proseOf(text)).length, ok: (await checkStructure(text, text)).ok });
    }
    console.log(JSON.stringify(results));
    await stopMarkdown();
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(), timeout: 5000, env: { ...process.env, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" },
  });
  expect(JSON.parse(stdout)).toEqual([
    { counts: { codeBlocks: 0, displayMath: 0, inlineMath: 0 }, proseLength: 50000, ok: true },
    { counts: { codeBlocks: 0, displayMath: 0, inlineMath: 0 }, proseLength: 50000, ok: true },
  ]);
}, 8000);
