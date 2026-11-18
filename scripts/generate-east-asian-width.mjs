import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Download https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt
// outside the repository, then pass that file as the sole argument.
const source = readFileSync(process.argv[2]);
const digest = createHash("sha256").update(source).digest("hex");
const expected = "ea7ce50f3444a050333448dffef1cadd9325af55cbb764b4a2280faf52170a33";
if (digest !== expected) throw new Error("Expected the pinned Unicode 17.0.0 EastAsianWidth.txt");
const ranges = [];
for (const line of source.toString("utf8").split("\n")) {
  const match = /^([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*;\s*[WF]\s/.exec(line);
  if (!match) continue;
  const start = parseInt(match[1], 16), end = parseInt(match[2] ?? match[1], 16);
  const last = ranges.at(-1);
  if (last && start === last[1] + 1) last[1] = end;
  else ranges.push([start, end]);
}
const header = `// Generated from Unicode 17.0.0 EastAsianWidth.txt (W and F only).
// https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt
// Source SHA-256: ${digest}
// Copyright 2025 Unicode, Inc. Unicode License v3; see THIRD_PARTY_NOTICES.md.
`;
let previous = 0;
const encoded = ranges.flatMap(([start, end]) => {
  const result = [(start - previous).toString(36), (end - start).toString(36)];
  previous = end + 1;
  return result;
}).join(".");
writeFileSync(new URL("../app/lib/east-asian-width.generated.ts", import.meta.url), header +
  "// Base-36 gaps and spans keep the fixed table small in browser bundles.\n" +
  "export const WIDE_RANGES: readonly (readonly [number, number])[] = (() => {\n" +
  `  const values = "${encoded}".split(".").map(value => parseInt(value, 36));\n` +
  "  const ranges: [number, number][] = [];\n  let previous = 0;\n" +
  "  for (let i = 0; i < values.length; i += 2) {\n    const start = previous + values[i], end = start + values[i + 1];\n" +
  "    ranges.push([start, end]); previous = end + 1;\n  }\n  return ranges;\n})();\n");
