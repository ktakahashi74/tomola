import { createContext, type RefObject } from "react";

// A review can change the form's language through the same state update as its select.
export const FormLanguageChangeContext = createContext<RefObject<((lang: string) => void) | null> | null>(null);
// Destination corrections belong to the form whose unchanged body was reviewed.
export type VillageReview = (slug: string | undefined, body: string, error: "village_required" | "village_changed") => void;
export const FormVillageReviewContext = createContext<RefObject<VillageReview | null> | null>(null);
