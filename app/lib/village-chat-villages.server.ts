import { inArray } from "drizzle-orm";
import { villages } from "./db/schema";
import { SHARED_VILLAGE_KINDS } from "./villages";
import { villageName } from "./village-name";
import type { Locale } from "~/paraglide/runtime.js";

// The single boundary for village kinds supporting chat. Expand here when private villages are implemented.
export function chatVillageCondition() { return inArray(villages.kind, [...SHARED_VILLAGE_KINDS]); }

// Mail may disclose a village name only for kinds whose names are public.
export function chatMailVillageName(village: { kind: string; name: string; language: string | null }, locale: Locale): string | undefined {
  return (SHARED_VILLAGE_KINDS as readonly string[]).includes(village.kind) ? villageName(village, locale) : undefined;
}
