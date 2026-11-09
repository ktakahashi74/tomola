// The line that names a post without a title in a list. It is the beginning of the body; when that is only an address, the place and the end of its path ("lesswrong.com › a-critical-look-at-lean4-1")
// say more than the whole address cut off. Anything else is returned as it is.
export function remarkLine(text: string): string {
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return text;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    return last ? `${host} › ${decodeURIComponent(last)}` : host;
  } catch {
    return text;
  }
}
