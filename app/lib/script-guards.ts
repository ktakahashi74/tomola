// Fake-engine guards for operational scripts pnpm embeddings:backfill and pnpm translations:requeue.
// Scripts choose engines from the app's environment. Without GEMINI_API_KEY, e.g. running locally against production DB, selection becomes fake:
//   - embeddings:backfill treats fake as the current model and all real-model embeddings as other-model rows,
//     so `--prune-other-models` deletes everything, emptying search. Enqueued embed_entry also generates fake embeddings.
//   - translations:requeue enqueues fake 「[ja] 原文」 translations.
// Therefore fake engines stop without doing anything unless explicit `--allow-fake` is supplied, as in keyless development.
export const ALLOW_FAKE_FLAG = "--allow-fake";

export function fakeEngineRefusal(opts: { script: string; engine: string; engineId: string; args: readonly string[] }): string | null {
  if (opts.engineId !== "fake" || opts.args.includes(ALLOW_FAKE_FLAG)) return null;
  return (
    `${opts.script} refused: the ${opts.engine} engine is "fake" in this environment (no API key, or the engine is set to fake), ` +
    "so it would queue jobs that make placeholder output" +
    (opts.script === "embeddings:backfill" ? ", and --prune-other-models would delete every real embedding" : "") +
    `. Run it where the real key is set (for example inside the app container), or pass ${ALLOW_FAKE_FLAG} if the fake engine is what you mean (development, staging).`
  );
}
