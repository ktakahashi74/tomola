import type * as core from "./structure.core.server";
import { markdownTask } from "../markdown-budget.server";
export { type StructureCounts, type CodeContent, type StructureCheck } from "./structure.core.server";

export function proseOf(...args: Parameters<typeof core.proseOf>): Promise<ReturnType<typeof core.proseOf>> {
  return markdownTask("proseOf", args);
}

export function countStructure(...args: Parameters<typeof core.countStructure>): Promise<ReturnType<typeof core.countStructure>> {
  return markdownTask("countStructure", args);
}

export function extractLinks(...args: Parameters<typeof core.extractLinks>): Promise<ReturnType<typeof core.extractLinks>> {
  return markdownTask("extractLinks", args);
}

export function extractCode(...args: Parameters<typeof core.extractCode>): Promise<ReturnType<typeof core.extractCode>> {
  return markdownTask("extractCode", args);
}

export function codeContentMismatches(...args: Parameters<typeof core.codeContentMismatches>): Promise<ReturnType<typeof core.codeContentMismatches>> {
  return markdownTask("codeContentMismatches", args);
}

export function checkStructure(...args: Parameters<typeof core.checkStructure>): Promise<ReturnType<typeof core.checkStructure>> {
  return markdownTask("checkStructure", args);
}
