import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "yaml";

const marker = "<!-- generated production notices -->";
type Package = { name: string; version: string; license?: unknown };
type LockedDependency = { specifier: string; version: string };
type Lock = { importers: Record<string, { dependencies: Record<string, LockedDependency>; devDependencies?: Record<string, LockedDependency> }>; snapshots: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>; packages: Record<string, { os?: string[]; cpu?: string[]; libc?: string[] }> };
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

function licenseFiles(directory: string, relative = ""): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...licenseFiles(directory, name));
    else if (/^(licen[sc]e|copying|copyright|notice|third.party.notices|ofl)([._-]|$)/i.test(entry.name) && !/\.(?:js|ts|map|json|png|svg|wasm|woff2?)$/i.test(entry.name)) files.push(name);
  }
  return files.sort();
}

export function generateNotices(root: string): string {
  const file = path.join(root, "THIRD_PARTY_NOTICES.md");
  const manual = fs.readFileSync(file, "utf8").split(marker)[0].trimEnd();
  // pnpm can put its package-manager lock and the project lock in separate YAML documents.
  const documents = parseAllDocuments(fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  for (const document of documents) if (document.errors.length) throw new Error("Invalid dependency lockfile");
  const lock = documents.map(d => d.toJSON() as Lock).find(d => d.importers?.["."]?.dependencies);
  if (!lock) throw new Error("Missing production dependencies in lockfile");
  const dependencies = readJson(path.join(root, "package.json")).dependencies as Record<string, string>;
  const locked = lock.importers["."].dependencies;
  if (JSON.stringify(Object.keys(dependencies).sort()) !== JSON.stringify(Object.keys(locked).sort()) || Object.entries(dependencies).some(([name, version]) => locked[name].specifier !== version)) throw new Error("Production dependency lock is out of date");
  const visited = new Set<string>();
  const excluded = new Set<string>();
  const libc = process.platform === "linux" && (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? "glibc" : "musl";
  const accepts = (values: string[] | undefined, value: string) => !values || (!values.includes(`!${value}`) && (values.every(v => v.startsWith("!")) || values.includes(value)));
  function supported(key: string) {
    const pkg = lock!.packages[key.split("(")[0]];
    return !pkg || (accepts(pkg.os, process.platform) && accepts(pkg.cpu, process.arch) && accepts(pkg.libc, libc));
  }
  function visit(name: string, version: string) {
    const key = `${name}@${version}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (!supported(key)) { excluded.add(key.split("(")[0]); return; }
    const snapshot = lock!.snapshots[key];
    if (!snapshot) throw new Error(`Missing dependency snapshot: ${key}`);
    for (const [child, ref] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) visit(child, ref);
  }
  for (const [name, ref] of Object.entries(locked)) visit(name, ref.version);
  // CSS supplied by a build-time dependency is still sent to browsers. Include
  // the contributing package, without treating its build-only CLI tree as shipped.
  const css = path.join(root, "app/app.css");
  const browserCss = fs.existsSync(css) ? [...fs.readFileSync(css, "utf8").matchAll(/@(?:import|plugin)\s+["']([^"']+)["']/g)]
    .map(match => match[1]).filter(name => !name.startsWith(".") && !name.startsWith("/"))
    .map(name => name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]) : [];
  for (const name of new Set(browserCss)) {
    const ref = locked[name] ?? lock.importers["."].devDependencies?.[name];
    if (!ref) throw new Error(`Missing locked browser CSS dependency: ${name}`);
    visited.add(`${name}@${ref.version}`);
  }
  const inventory = new Map<string, string>();
  function add(directory: string) {
    if (!fs.existsSync(path.join(directory, "package.json"))) return;
    const pkg = readJson(path.join(directory, "package.json")) as Package;
    inventory.set(`${pkg.name}@${pkg.version}`, directory);
  }
  const modules = path.join(root, "node_modules");
  function scan(directory: string) {
    for (const name of fs.readdirSync(directory)) {
      if (name.startsWith(".")) continue;
      const entry = path.join(directory, name);
      if (name.startsWith("@")) { for (const child of fs.readdirSync(entry)) add(path.join(entry, child)); }
      else add(entry);
    }
  }
  scan(modules);
  const store = path.join(modules, ".pnpm");
  if (fs.existsSync(store)) for (const name of fs.readdirSync(store)) {
    const directory = path.join(store, name, "node_modules");
    if (fs.existsSync(directory)) scan(directory);
  }
  const keys = [...new Set([...visited].map(key => key.split("(")[0]))].sort();
  const fingerprint = createHash("sha256").update(JSON.stringify({ dependencies, snapshots: [...visited].sort().map(key => [key, lock.snapshots[key]]), packages: keys.map(key => [key, lock.packages[key]]) })).digest("hex");
  const sections = [manual, marker, "## Locked production and browser CSS dependency notices", `Generated by \`pnpm notices:generate\` for ${process.platform}/${process.arch}. Includes transitive production dependencies, browser CSS/fonts (including CSS from build-time dependencies), and installed native libraries. Packages for other platforms are listed separately. Regenerate on the platform of an image you distribute.`, `Production graph SHA-256: \`${fingerprint}\`.`];
  const absent: string[] = [...excluded].sort();
  for (const key of keys) {
    if (excluded.has(key)) continue;
    const directory = inventory.get(key);
    if (!directory) {
      throw new Error(`Install locked production dependency before generating notices: ${key}`);
    }
    const pkg = readJson(path.join(directory, "package.json")) as Package;
    sections.push(`### ${key}`, `License metadata: \`${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? "not specified")}\`.`);
    const files = licenseFiles(directory);
    // Native libvips packages carry their component/license table in README.md.
    if (pkg.name.startsWith("@img/sharp-libvips-")) files.push("README.md");
    if (!files.length) {
      const readme = fs.readdirSync(directory).find(name => /^readme(?:\.md|\.txt)?$/i.test(name));
      if (readme) files.push(readme);
    }
    for (const name of files) sections.push(`Bundled text: \`${name}\``, "````text\n" + fs.readFileSync(path.join(directory, name), "utf8").trimEnd() + "\n````");
  }
  if (absent.length) sections.push("### Packages for other platforms (not installed)", ...absent.map(key => `- ${key}`));
  const supplements = path.join(root, "scripts/licenses");
  if (fs.existsSync(supplements)) for (const name of fs.readdirSync(supplements).sort()) sections.push(`## Supplemental upstream text: ${name}`, fs.readFileSync(path.join(supplements, name), "utf8").trimEnd());
  return sections.join("\n\n").split("\n").map(line => line.trimEnd()).join("\n") + "\n";
}

export function checkNotices(root: string): void {
  if (fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8") !== generateNotices(root)) throw new Error("Third-party notices are out of date; run pnpm notices:generate");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (process.argv.includes("--check")) checkNotices(root);
  else fs.writeFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), generateNotices(root));
}
