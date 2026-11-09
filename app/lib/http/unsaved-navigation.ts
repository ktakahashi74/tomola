export const UNSAVED_NAVIGATION_EVENT = "tomola:confirm-unsaved";

// Ask the mounted editor before an operation changes browser state and reloads.
export function confirmUnsavedNavigation(): boolean {
  return window.dispatchEvent(new Event(UNSAVED_NAVIGATION_EVENT, { cancelable: true }));
}
