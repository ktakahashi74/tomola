type Env = Record<string, string | undefined>;
export function translationEagerConfig(env: Env = process.env): { scope: "all" | "readers"; minReaders: number } {
  const scope = env.TRANSLATION_EAGER_SCOPE?.trim() || "readers";
  const raw = env.TRANSLATION_EAGER_MIN_READERS?.trim() || "1";
  if (scope !== "all" && scope !== "readers") throw new Error("TRANSLATION_EAGER_SCOPE must be all or readers");
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("TRANSLATION_EAGER_MIN_READERS must be a positive safe integer");
  return { scope, minReaders: Number(raw) };
}
