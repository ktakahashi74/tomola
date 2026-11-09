import { parse } from "yaml";
import { z } from "zod";

export const EVAL_LANGS = ["ja", "en", "fr", "zh-Hans", "zh-Hant"] as const;
export const EVAL_CATEGORIES = ["rights", "negation", "hedging", "attribution", "stance", "terminology", "culture", "symbols", "short-reply"] as const;
export const CHECK_KINDS = ["semantic", "mentions", "urls", "code", "math", "markdown", "numbers"] as const;
const checkSchema = z.object({ id: z.string().min(1), kind: z.enum(CHECK_KINDS), description: z.string().min(1) }).strict();
const caseSchema = z.object({
  id: z.string().regex(/^E\d{2}$/), category: z.enum(EVAL_CATEGORIES), from: z.enum(EVAL_LANGS),
  source: z.discriminatedUnion("kind", [z.object({ kind: z.literal("example") }).strict(), z.object({ kind: z.literal("published"), path: z.string().min(1).optional(), passage: z.string().min(1) }).strict()]),
  text: z.string().min(1).max(20_000), weight: z.enum(["heavy", "normal"]), to: z.array(z.enum(EVAL_LANGS)).min(1), checks: z.array(checkSchema).min(1).max(20),
  title: z.string().min(1).max(300).optional(),
  respondsTo: z.string().regex(/^E\d{2}$/).optional(),
}).strict();
export const evalSetSchema = z.object({ version: z.string().min(1), cases: z.array(caseSchema).min(1).max(500) }).strict().superRefine((set, ctx) => {
  const ids = new Set<string>();
  for (const item of set.cases) {
    if (item.respondsTo) {
      const original = set.cases.find(c => c.id === item.respondsTo);
      if (!ids.has(item.respondsTo) || !original || original.from !== item.from || item.to.some(to => !original.to.includes(to))) ctx.addIssue({ code: "custom", message: `Response reference must precede ${item.id} and cover its language pairs` });
    }
    if (ids.has(item.id) || new Set(item.to).size !== item.to.length || item.to.includes(item.from) || new Set(item.checks.map(c => c.id)).size !== item.checks.length) ctx.addIssue({ code: "custom", message: `Duplicate ID, target, or same-language target in ${item.id}` });
    ids.add(item.id);
  }
});
export type EvalSet = z.infer<typeof evalSetSchema>;
export type EvalCase = EvalSet["cases"][number];
export type EvalCheck = EvalCase["checks"][number];
export type CheckResult = { id: string; preserved: boolean; severe: boolean; reason: string };
export const parseEvalSet = (source: string): EvalSet => evalSetSchema.parse(parse(source));

export const evalMentions = (text: string) => [...text.matchAll(/@[a-zA-Z][a-zA-Z0-9_]*/g)].map(m => m[0]);
