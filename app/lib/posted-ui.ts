// Carry publication feedback through redirects while preserving reply pages, language, and anchors.
export function postedLocation(location: string, entryId: number, followed = false): string {
  const url = new URL(location, "http://localhost");
  url.searchParams.set("posted", String(entryId));
  if (followed) url.searchParams.set("followed", "1");
  else url.searchParams.delete("followed");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readPostedId(url: URL): number | null {
  const raw = url.searchParams.get("posted");
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// A saved edit is told the same way: the address of the redirect carries which entry was edited, and the topic page says so once.
export function editedLocation(location: string, entryId: number): string {
  const url = new URL(location, "http://localhost");
  url.searchParams.set("edited", String(entryId));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readEditedId(url: URL): number | null {
  const raw = url.searchParams.get("edited");
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
