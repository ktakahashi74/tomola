import { useSyncExternalStore } from "react";

// Whether the reader of a public document turned out to be a member. The documents are the same HTML for everyone, so this is only known after the header has asked
// the server (the header sets it); until then, and on the server, the reader counts as not a member.
let member = false;
const listeners = new Set<() => void>();
export function setDocumentMember(value: boolean) {
  if (member === value) return;
  member = value;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useDocumentMember = () => useSyncExternalStore(subscribe, () => member, () => false);
