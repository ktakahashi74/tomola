// Compare translation models: translate the same texts with two models from one provider into side-by-side Markdown for human readers. Choose primary and retry models through human evaluation.
//
//   pnpm translations:compare --models gemini-3.5-flash-lite,gemini-3.8-flash --input texts.json --langs fr,zh-Hans,zh-Hant --out ./compare-out --blind --seed 1
//   pnpm translations:compare --models gemini-3.5-flash-lite,gemini-3.8-flash --input ./texts-dir --langs auto --out ./out/ja-en --per-text --key-dir ./key/ja-en --blind --seed 1   (Directory: one frontmatter-bearing file per text.)
//   Match TRANSLATION_PRIMARY to the model provider. Glossary is supplied by default; use --glossary <file> or --no-glossary.
//
// Arguments/output: the introduction of app/lib/llm/compare-cli.server.ts. Neither DB nor monthly budget is touched. Estimate costs before real calls
// and stop there with --dry-run. Keys: GEMINI_API_KEY, ANTHROPIC_API_KEY, loaded from .env.
import { runCompareCli } from "../app/lib/llm/compare-cli.server";

process.exit(await runCompareCli(process.argv.slice(2)));
