import { format } from "node:util";
import { runI18n } from "../../scripts/i18n-translate";
import type { CliOutput } from "../../scripts/cli";

export type CliResult = { status: number; stdout: string; stderr: string };
export async function captureCli(run: (output: CliOutput) => Promise<number>): Promise<CliResult> {
  const result: CliResult = { status: 0, stdout: "", stderr: "" };
  const output: CliOutput = {
    log: (...args) => { result.stdout += format(...args) + "\n"; },
    warn: (...args) => { result.stderr += format(...args) + "\n"; },
    error: (...args) => { result.stderr += format(...args) + "\n"; },
    write: async text => { result.stdout += text; },
  };
  try { result.status = await run(output); }
  catch (error) { result.status = 1; output.error(error instanceof Error ? error.message : error); }
  return result;
}
export const invokeI18n = (args: string[], env: NodeJS.ProcessEnv) => captureCli(output => runI18n(args, env, output));
