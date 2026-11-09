import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeErrorText } from "../app/lib/error-text.server";

export type CliOutput = Pick<Console, "log" | "warn" | "error"> & { write(text: string): Promise<void> };
export const cliOutput: CliOutput = {
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  write: text => new Promise((resolve, reject) => process.stdout.write(text, error => error ? reject(error) : resolve())),
};

// Catch at the executable boundary as well as within argument validation:
// database work can fail after a successful connection was established.
export async function runCli(run: () => Promise<number | void>, output: Pick<Console, "error"> = cliOutput): Promise<number> {
  try { return await run() ?? (Number(process.exitCode) || 0); }
  catch (error) { output.error(safeErrorText(error)); return 1; }
}
export function isMain(url: string): boolean {
  if (!process.argv[1]) return false;
  // Resolve extensionless entrypoints with the active loader before following symlinks.
  const entrypoint = createRequire(url).resolve(path.resolve(process.argv[1]));
  return realpathSync(entrypoint) === realpathSync(fileURLToPath(url));
}
