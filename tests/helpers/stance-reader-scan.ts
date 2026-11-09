import fs from "node:fs";
import path from "node:path";

// Source scan for "who reads the stance tables" (tests/distribution.test.ts). It is a text scan, not a parser: it catches the ways the tables are normally reached
// (a named import from the schema module, a namespace import and `ns.stances`, `schema.stances`, `db.query.stances`, raw SQL) and treats a dynamic import of
// the schema module as touching both tables, since the names cannot be read from it. Raw SQL assembled from parts at run time is out of reach.

export type StanceTable = "stances" | "stanceChanges";
export type StanceTableUses = { tables: Set<StanceTable>; reasons: string[] };

// Comments are removed first, so that a comment that mentions a table (or a file that only talks about them) is not a use. `//` counts as a comment only at the start of a line or
// after whitespace (not in "https://..."), `/*` likewise.
export function stripComments(source: string): string {
  return source.replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/(^|\s)\/\/.*$/gm, "$1");
}

// The last path segment of the specifier is `schema` (with or without an extension): "~/lib/db/schema", "../lib/db/schema.ts", "./schema", "../db/schema.js".
const SCHEMA_SPECIFIER = /(?:^|\/)schema(?:\.[cm]?[jt]sx?)?$/;
const TABLE_NAMES: readonly StanceTable[] = ["stances", "stanceChanges"];
const asTable = (name: string): StanceTable | null => (TABLE_NAMES as readonly string[]).includes(name) ? (name as StanceTable) : null;

export function findStanceTableUses(source: string): StanceTableUses {
  const code = stripComments(source);
  const tables = new Set<StanceTable>();
  const reasons: string[] = [];
  const add = (table: StanceTable, reason: string) => {
    tables.add(table);
    reasons.push(`${table}: ${reason}`);
  };

  // 1. Static imports and re-exports from the schema module: default, namespace and named forms (`import type` too).
  const namespaces = new Set<string>(["schema"]);
  const clause = /\b(?:import|export)\s+(?:type\s+)?((?:[\w$]+\s*,\s*)?(?:\*\s*as\s+[\w$]+|\{[^}]*\}|[\w$]+))\s*from\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(clause)) {
    const [, names, specifier] = match;
    if (!SCHEMA_SPECIFIER.test(specifier)) continue;
    const namespace = /\*\s*as\s+([\w$]+)/.exec(names);
    if (namespace) namespaces.add(namespace[1]);
    const braces = /\{([^}]*)\}/.exec(names);
    for (const entry of (braces?.[1] ?? "").split(",")) {
      const table = asTable(entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim());
      if (table) add(table, `named import from "${specifier}"`);
    }
  }

  // 2. A dynamic import or require of the schema module: the names cannot be read, so both tables count.
  for (const match of code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    if (SCHEMA_SPECIFIER.test(match[1])) for (const table of TABLE_NAMES) add(table, `dynamic import of "${match[1]}"`);
  }

  // 3. Member access: `schema.stances`, `<namespace>.stances`, `.query.stances`, and destructuring from a namespace.
  for (const ns of namespaces) {
    const escaped = ns.replace(/\$/g, "\\$");
    for (const match of code.matchAll(new RegExp(`\\b${escaped}\\s*\\.\\s*(stances|stanceChanges)\\b`, "g"))) add(match[1] as StanceTable, `${ns}.${match[1]}`);
    for (const match of code.matchAll(new RegExp(`\\{([^}]*)\\}\\s*=\\s*${escaped}\\b`, "g"))) {
      for (const entry of match[1].split(",")) {
        const table = asTable(entry.trim().split(/\s*:\s*/)[0].trim());
        if (table) add(table, `destructured from ${ns}`);
      }
    }
  }
  for (const match of code.matchAll(/\.\s*query\s*\.\s*(stances|stanceChanges)\b/g)) add(match[1] as StanceTable, `.query.${match[1]}`);

  // 4. Raw SQL, in any string or template literal: either name must stand as a table, right after from, join, into, update, table or truncate (with an optional schema
  // qualifier and quotes), or in a comma-joined FROM list. Both names also occur as fields in the member-export documentation, which does not read the tables.
  const literals = code.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
  // A comma-separated FROM list contains table names and optional aliases, not arbitrary prose extending across an entire guide.
  const table = '(?:only\\s+)?(?:"?\\w+"?\\.)?"?\\w+"?(?:\\s+(?:as\\s+)?"?\\w+"?)?';
  for (const [name, sqlName] of [["stances", "stances"], ["stanceChanges", "stance_changes"]] as const) {
    const asTableName = new RegExp(`\\b(?:from|join|into|update|table|truncate)\\s+(?:only\\s+)?(?:"?\\w+"?\\.)?"?${sqlName}\\b`, "i");
    const inFromList = new RegExp(`\\bfrom\\s+${table}(?:\\s*,\\s*${table})*\\s*,\\s*(?:"?\\w+"?\\.)?"?${sqlName}\\b`, "i");
    for (const literal of literals) {
      if (asTableName.test(literal) || inFromList.test(literal)) add(name, `raw SQL mentioning ${sqlName}`);
    }
  }
  return { tables, reasons };
}

// ---- reading the repository (for the real scan) ----

const SOURCE = /\.(ts|tsx)$/;
const SKIPPED_DIRS = new Set(["paraglide", "node_modules", "build", ".data"]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(full);
    return SOURCE.test(entry.name) ? [full] : [];
  });
}

// The application sources that run in production or in the operator's scripts: app/, server/, scripts/ and server.ts. Repository-relative paths with `/`.
export function productionSources(root = process.cwd()): Array<{ file: string; text: string }> {
  const files = ["app", "server", "scripts"].flatMap((d) => (fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : []));
  if (fs.existsSync(path.join(root, "server.ts"))) files.push(path.join(root, "server.ts"));
  return files.map((f) => ({ file: path.relative(root, f).split(path.sep).join("/"), text: fs.readFileSync(f, "utf8") }));
}
