import path from "node:path";

// Keep diagnostics limited to test identities, without messages or host paths.
export function metadataText(value: string, root?: string) {
  const text = root ? String(value).replaceAll(root, "[path]") : String(value);
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(?:\/(?:home|Users|tmp|var|private|opt|mnt)\/|(?<![A-Z])[A-Z]:[\\/])[^\s"'<>]+/gi, "[path]");
}

export function relativeTestFile(root: string, file: string) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  return relative && !relative.startsWith("../") && !path.isAbsolute(relative) ? metadataText(relative) : "[external]";
}
