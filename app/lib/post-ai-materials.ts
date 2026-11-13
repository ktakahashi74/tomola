export const POST_AI_MATERIAL_CHARS = 20_000;
export const instructionWarnings = (text: string): string[] => [
  [/ignore\s+(?:all\s+|the\s+|any\s+|previous\s+)*(?:instructions|rules)|disregard\s+.*instructions/i, "override"],
  [/you\s+are\s+(?:now\s+)?(?:an?\s+|to\s+)|(?:always|must)\s+(?:answer|respond)|system\s*prompt/i, "role_or_answer"],
  [/(?:これまで|以前|上記|すべて)の?(?:指示|命令).*無視|あなたは.*(?:として|答え)|必ず.*(?:答え|回答)|批判.*取り合わ/u, "instruction_ja"],
].flatMap(([pattern, key]) => (pattern as RegExp).test(text) ? [key as string] : []);
