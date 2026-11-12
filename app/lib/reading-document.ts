// Root import captures the initial document before client navigation. The key
// stays in memory and is never sent, persisted or used to identify a reader.
export const documentKey = typeof window === "undefined" ? null : window.history.state?.key ?? "default";
