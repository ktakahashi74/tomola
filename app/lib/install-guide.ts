export const INSTALL_GUIDE_DISMISSED = "tomola:install-guide-dismissed";

export function isIosDevice({ userAgent, platform, maxTouchPoints }: { userAgent: string; platform: string; maxTouchPoints: number }) {
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

export function isIosSafari(device: Parameters<typeof isIosDevice>[0]) {
  return isIosDevice(device) && /Version\/[\d.]+.*Safari\//.test(device.userAgent)
    && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(device.userAgent);
}

export function installGuideMode(state: {
  member: boolean; coarsePointer: boolean; standalone: boolean;
  iosSafari: boolean; canPrompt: boolean; dismissed: boolean; installed: boolean;
}): "ios" | "prompt" | null {
  if (!state.member || !state.coarsePointer || state.standalone || state.dismissed || state.installed) return null;
  if (state.iosSafari) return "ios";
  return state.canPrompt ? "prompt" : null;
}

type GuideStorage = Pick<Storage, "getItem" | "setItem">;
export function guideDismissed(storage: GuideStorage | null) {
  try { return storage?.getItem(INSTALL_GUIDE_DISMISSED) === "1"; }
  catch { return false; }
}

export function rememberGuideDismissed(storage: GuideStorage | null) {
  try { storage?.setItem(INSTALL_GUIDE_DISMISSED, "1"); }
  catch { /* Keep the in-memory dismissal when browser storage is unavailable. */ }
}

export function standaloneDisplay() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
