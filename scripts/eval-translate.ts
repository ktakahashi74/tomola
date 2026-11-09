// Deliberately does not load .env. Supply settings explicitly to this operator command.
import { runEvalCli } from "../app/lib/eval/cli.server";
import { safeErrorText } from "../app/lib/error-text.server";

runEvalCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  console.error(safeErrorText(error));
  process.exitCode = 1;
});
