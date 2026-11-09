import fs from "node:fs";
import path from "node:path";
import { TARGET_LOCALES, type Messages } from "~/lib/i18n/messages";
import { getLocale } from "~/paraglide/runtime.js";

// Read real messages/<locale>.json and expose Paraglide m's shape, m.<key>(inputs, { locale }). Ordinary tests avoid generated dependencies
// by replacing messages with empty strings (tests/stubs/paraglide-messages.ts). Only wording-sensitive tests, such as mail-language checks,
// use this through vi.mock("~/paraglide/messages.js", ...). Throw on missing keys or inputs, catching missing ja.json keys too.
type Table = Messages;
const tables: Record<string, Table> = {};
function table(locale: string): Table {
  return (tables[locale] ??= JSON.parse(fs.readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Table);
}

export function jsonMessages() {
  return new Proxy({} as Record<string, (inputs?: Record<string, unknown>, options?: { locale?: string }) => string>, {
    get: (_target, key) => (inputs: Record<string, unknown> = {}, options: { locale?: string } = {}) => {
      const locale = options.locale ?? getLocale();
      let template = table(locale)[String(key)] ?? ((TARGET_LOCALES as readonly string[]).includes(locale) ? table("en")[String(key)] : undefined);
      if (template === undefined) throw new Error(`message ${String(key)} is missing in ${options.locale ?? getLocale()}`);
      if (typeof template !== "string") {
        const plural = template[0];
        const declaration = /local (\w+) = (\w+): plural/.exec(plural.declarations.find(d => d.startsWith("local ")) ?? "")!;
        const category = new Intl.PluralRules(table(locale)[String(key)] ? locale : "en").select(Number(inputs[declaration[2]]));
        template = plural.match[`${declaration[1]}=${category}`] ?? plural.match[`${declaration[1]}=other`];
      }
      return template.replace(/\{(\w+)\}/g, (_, name: string) => {
        if (!(name in inputs)) throw new Error(`message ${String(key)}: input ${name} is missing`);
        return String(inputs[name]);
      });
    },
  });
}
