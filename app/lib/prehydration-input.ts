// Reloads and history loads may restore an older textarea over newer server text.
// Other arrivals keep native edits, including clearing the field before hydration.
export function prehydrationBody(body: Pick<HTMLTextAreaElement, "value" | "defaultValue">, navigation: PerformanceNavigationTiming["type"] | undefined): string | undefined {
  return navigation !== "reload" && navigation !== "back_forward" && body.value !== body.defaultValue ? body.value : undefined;
}
