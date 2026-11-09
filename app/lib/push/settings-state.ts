export type PushSettingsState = "unsupported" | "install" | "off" | "registering" | "active" | "blocked" | "reconnect" | "login";
export function pushRestoreBrowser(agent: string, ios: boolean) {
  if (ios) return "ios";
  if (/Firefox/.test(agent)) return "firefox";
  if (/Android/.test(agent)) {
    // Chromium-based browsers add their own tokens. Use the generic steps
    // unless this is the recognizable Android Chrome User-Agent shape.
    return /^Mozilla\/5\.0 \([^)]*Android[^)]*\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\) Chrome\/[\d.]+ (?:Mobile )?Safari\/[\d.]+$/.test(agent) ? "android" : "browser";
  }
  if (/Edg/.test(agent)) return "edge";
  if (/Safari/.test(agent) && !/Chrome/.test(agent)) return "safari";
  return /Chrome/.test(agent) ? "chrome" : "browser";
}
export function pushSettingsState(value: { ios: boolean; standalone: boolean; supported: boolean; busy: boolean; login: boolean;
  permission: NotificationPermission; subscription: boolean; registration: boolean; matches: boolean }): PushSettingsState {
  if (value.login) return "login";
  if (value.ios && !value.standalone) return "install";
  if (!value.supported) return "unsupported";
  if (value.busy) return "registering";
  if (value.permission === "denied") return "blocked";
  if (value.permission === "granted" && value.subscription && value.registration && value.matches) return "active";
  return value.subscription || value.registration ? "reconnect" : "off";
}
