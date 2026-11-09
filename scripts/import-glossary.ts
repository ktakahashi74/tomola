import { safeErrorText } from "../app/lib/error-text.server.ts";
import { cliOutput, isMain, runCli, type CliOutput } from "./cli";
// Import initial glossary entries: build glossary_entries for all directions among five languages from docs/drafts/glossary-initial.yaml.
// The database is authoritative. YAML serves initial import/export; by default add only new rows and never overwrite existing rows.
// Writes use glossary_revisions history functions. --as identifies the operator, preventing new history without an editor.
//
//   pnpm glossary:import docs/drafts/glossary-initial.yaml --as <operator handle>             Add only new rows; list differing existing rows without overwriting. Never delete rows absent from the file.
//   pnpm glossary:import docs/drafts/glossary-initial.yaml --as <handle> --dry-run           Preview added/updated counts and glossary-version changes without writes.
//   pnpm glossary:import docs/drafts/glossary-initial.yaml --as <handle> --update            Overwrite differing rows with file contents, except manual UI edits/deletions and changes
//                                                                                              resetting verified rows to needs-review; list those without overwriting.
//   pnpm glossary:import docs/drafts/glossary-initial.yaml --as <handle> --overwrite-edited  Overwrite those two cases too; implies --update.
//   --proposal <topic id or URL>   Record the same underlying proposal entry on every change in this import.
//
// If the --as member is not an OPERATOR_EMAILS operator, exit 1 without DB writes. Operators must log in once and become members before running.
// Format and export round-trip rules (pnpm glossary:export): introduction of app/lib/glossary-io.server.ts. translations.glossary_version hashes active row contents and changes when contents change.
// Stop the development server first: PGlite cannot open the same data from multiple processes. Production PostgreSQL may remain running.
import fs from "node:fs";
import { getOperatorDb as getDb } from "../app/lib/db/client.server";
import { expandGlossaryFile, GlossaryImportError, importGlossaryRows, parseGlossaryFile, resolveImportOperator } from "../app/lib/glossary-io.server";

const USAGE = "usage: pnpm glossary:import <file.yaml> --as <operator handle> [--proposal <topic id or URL>] [--dry-run] [--update] [--overwrite-edited]";
const FLAGS = ["--dry-run", "--update", "--overwrite-edited"];
const VALUED = ["--as", "--proposal"];

export async function runGlossaryImport(argv: string[], openDb: typeof getDb = getDb, output: CliOutput = cliOutput): Promise<number> {
  const files: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const problems: string[] = [];
  {
      for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
      if (VALUED.includes(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) problems.push(`${name} needs a value`);
        else values.set(name, value);
      } else if (FLAGS.includes(arg)) flags.add(arg);
      else if (arg.startsWith("--")) problems.push(`unknown option: ${arg}`);
      else files.push(arg);
    }
  }
  if (!values.has("--as") && problems.length === 0) problems.push("--as <operator handle> is required (the changes are recorded under that member)");
  if (files.length !== 1 || problems.length > 0) {
    output.error(`${problems.length > 0 ? `${problems.join("\n")}\n` : ""}${USAGE}`);
    return 1;
  }
  const dryRun = flags.has("--dry-run");
  const overwriteEdited = flags.has("--overwrite-edited");
  const update = flags.has("--update") || overwriteEdited;
  const handle = values.get("--as") as string;
  const proposal = values.get("--proposal");

  let text: string;
  try {
    text = fs.readFileSync(files[0], "utf8");
  } catch (error) {
    output.error(`cannot read ${files[0]}: ${safeErrorText(error)}`);
    return 1;
  }
  const parsed = parseGlossaryFile(text);
  if (!parsed.ok) {
    output.error(`${files[0]} is not a valid glossary file:\n${parsed.errors.map((e) => `  - ${e}`).join("\n")}`);
    return 1;
  }
  const expanded = expandGlossaryFile(parsed.file);
  if (expanded.conflicts.length > 0) {
    output.warn(`warning: ${expanded.conflicts.length} row(s) of a later entry were not made, because an earlier entry has the same word:\n${expanded.conflicts.map((c) => `  - ${c}`).join("\n")}`);
  }

  if (expanded.overrides.length > 0) {
    output.warn(`warning: ${expanded.overrides.length} row(s) written in rows: replace a row that an entry makes, with other content:\n${expanded.overrides.map((c) => `  - ${c}`).join("\n")}`);
  }

  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await openDb();
  } catch (error) {
    // A running development server causes a lock error; no stack trace needed.
    output.error(safeErrorText(error));
    return 1;
  }
  const operator = await resolveImportOperator(db, handle);
  if (!operator.ok) {
    output.error(operator.error === "no_such_member" ? `--as ${handle}: there is no member with that handle (log in once to become a member first)` : `--as ${handle}: that member is not an operator (OPERATOR_EMAILS)`);
    return 1;
  }
  let summary: Awaited<ReturnType<typeof importGlossaryRows>>;
  try {
    summary = await importGlossaryRows(db, expanded.rows, { dryRun, update, overwriteEdited, actor: operator.actor, proposal });
  } catch (error) {
    if (!(error instanceof GlossaryImportError)) throw error;
    output.error(`${safeErrorText(error)}\nnothing was written`);
    return 1;
  }
  const source = parsed.file.rows.length > 0 ? `${parsed.file.entries.length} entries and ${parsed.file.rows.length} rows` : `${parsed.file.entries.length} entries`;
  output.log(
    `${source} make ${summary.total} rows: ${summary.created} ${dryRun ? "would be created" : "created"}, ${summary.updated} ${dryRun ? "would be updated" : "updated"}, ${summary.unchanged} unchanged, ${summary.skipped.length} existing rows left as they are${dryRun ? " (dry run: nothing was written)" : ""}`,
  );
  if (summary.skipped.length > 0) {
    const why = { differs: "differs from the file", edited: "edited or deleted by a person in the admin page", review_reset: "the file would mark a checked row as needing review again" } as const;
    const shown = summary.skipped.slice(0, 30);
    output.log(`rows that exist and were not changed (${summary.skipped.length}):\n${shown.map((r) => `  - "${r.term}" (${r.lang} -> ${r.targetLang}): ${why[r.reason]}`).join("\n")}${summary.skipped.length > shown.length ? `\n  … and ${summary.skipped.length - shown.length} more` : ""}`);
    output.log(
      update
        ? "(--update does not touch rows that a person edited, or checked rows that the file would put back to needing review; --overwrite-edited does.)"
        : "(the database is the source of truth: --update rewrites the rows that differ and that nobody edited; --overwrite-edited rewrites the edited ones too.)",
    );
  }
  output.log(`glossary version: ${summary.versionBefore ?? "(empty)"} -> ${summary.versionAfter ?? "(empty)"}${dryRun ? " (not changed: dry run)" : summary.versionBefore === summary.versionAfter ? " (unchanged)" : ""}`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(await runCli(() => runGlossaryImport(process.argv.slice(2))));
