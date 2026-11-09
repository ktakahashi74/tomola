import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Db } from "~/lib/db/client.server";
import { closeDb, getOperatorDb } from "~/lib/db/client.server";
import type { LlmEnv } from "~/lib/llm/types";
import { parseEvalSet } from "./cases.server";
import { estimateEvaluation, runEvaluation } from "./run.server";

export async function runEvalCli(argv: string[], io: { env: LlmEnv; read?: () => Promise<string>; openDb?: () => Promise<Db>; closeDb?: (db: Db) => Promise<void>; log: (text: string) => void } = { env: process.env, log: console.log }): Promise<number> {
  if (argv.some(arg => !["--estimate", "--allow-paid"].includes(arg))) throw new Error("Usage: pnpm eval:translate [--estimate] [--allow-paid]");
  const source = await (io.read ?? (() => fs.readFile(fileURLToPath(new URL("../../../eval/translation/cases.yaml", import.meta.url)), "utf8")))();
  const set = parseEvalSet(source);
  const estimate = estimateEvaluation(set, io.env);
  io.log(JSON.stringify(estimate, null, 2));
  if (argv.includes("--estimate")) return 0;
  if ((estimate.translator.provider !== "fake" || estimate.judge.provider !== "fake") && !argv.includes("--allow-paid")) throw new Error("Real API calls require explicit approval after reviewing --estimate; then pass --allow-paid.");
  const db = await (io.openDb ?? getOperatorDb)();
  try { const out = await runEvaluation(db, set, io.env); io.log(JSON.stringify(out, null, 2)); return out.status === "completed" ? 0 : 1; }
  finally { await (io.closeDb ?? closeDb)(db); }
}
