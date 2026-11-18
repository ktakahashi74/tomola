// Give each playback its own decoded image, starting at the first frame. The
// in-memory WebP loops indefinitely; stored bytes and delivery stay unchanged.
let playback = 0;
export function prepareMotionPlayback(bytes: ArrayBuffer): number {
  const view = new DataView(bytes);
  let animated = false, duration = 0;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > bytes.byteLength) throw new Error("Invalid motion image");
    if (view.getUint32(offset) === 0x414e494d && size === 6) {
      view.setUint16(start + 4, 0, true);
      animated = true;
    }
    if (view.getUint32(offset) === 0x414e4d46 && size >= 16) {
      const delay = view.getUint16(start + 12, true) + view.getUint8(start + 14) * 65536;
      // Match browser timing, including zero-delay frames in older uploads.
      duration += delay <= 10 ? 100 : delay;
    }
    offset = start + size + size % 2;
  }
  if (!animated || !duration) throw new Error("Missing motion frames");
  return duration;
}
async function playbackSource(bytes: ArrayBuffer) {
  const duration = prepareMotionPlayback(bytes);
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type: `image/webp;playback=${++playback}` }));
  });
  return { source, duration };
}

// Upgrade the no-JS link only on pages with motion figures. An observer never
// fetches motion before half the still is visible, or with reduced motion.
export function activateMotionFigures(root: HTMLElement, played = new Set<string>()) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let printing = window.matchMedia("print").matches;
  const checks: Array<() => void> = [], stops: Array<() => void> = [], cleanups: Array<() => void> = [];
  const occurrences = new Map<string, number>();
  const visibility = new Map<Element, (visible: boolean) => void>();
  const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
    for (const entry of entries) visibility.get(entry.target)?.(entry.isIntersecting && entry.intersectionRatio >= 0.5);
  }, { threshold: 0.5 });
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[data-motion-open]")) {
    const figure = link.closest<HTMLElement>("[data-motion-figure]")!, image = figure.querySelector<HTMLImageElement>("img");
    if (!image) continue;
    const url = link.getAttribute("href")!, show = link.textContent!, back = link.dataset.motionBack!;
    const still = figure.querySelector<HTMLElement>("[data-translated-figure]")?.dataset.figureOriginal ?? image.getAttribute("src");
    const pair = `${url}:${still}`, occurrence = occurrences.get(pair) ?? 0;
    occurrences.set(pair, occurrence + 1);
    const key = `${pair}:${occurrence}`;
    const button = document.createElement("button");
    button.type = "button"; button.className = "underline cursor-pointer"; button.textContent = show;
    let mode: "auto" | "manual" | null = null, visible = false;
    let request: AbortController | undefined, animation: HTMLImageElement | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const note = figure.querySelector<HTMLElement>("[data-motion-note]");
    const translated = figure.querySelector<HTMLElement>("[data-translated-figure]");
    const explain = !!translated && translated.dataset.figureTranslated !== translated.dataset.figureOriginal;
    // Reserve the translated figure's note row before playback as well.
    if (note && explain) { note.hidden = false; note.style.visibility = "hidden"; }
    const controls = [...figure.querySelectorAll<HTMLElement>("[data-figure-toggle], [data-figure-fallback]")];
    const controlVisibility = controls.map(control => control.style.visibility);
    const stop = () => {
      request?.abort(); request = undefined;
      clearTimeout(timer);
      animation?.remove(); animation = undefined;
      image.hidden = false;
      button.textContent = show;
      if (note && explain) note.style.visibility = "hidden";
      if (mode) controls.forEach((control, index) => { control.style.visibility = controlVisibility[index]; });
      mode = null;
    };
    const start = async (automatic: boolean) => {
      played.add(key);
      mode = automatic ? "auto" : "manual";
      button.textContent = back;
      for (const control of controls) control.style.visibility = "hidden";
      const pending = request = new AbortController();
      try {
        const response = await fetch(url, { signal: pending.signal });
        if (!response.ok) throw new Error("Motion unavailable");
        const { source, duration } = await playbackSource(await response.arrayBuffer());
        if (pending.signal.aborted) return;
        const moving = animation = image.cloneNode() as HTMLImageElement;
        moving.hidden = false; moving.loading = "eager";
        moving.onload = () => {
          if (pending.signal.aborted) return;
          image.after(moving); image.hidden = true;
          if (note && explain) note.style.visibility = "";
          if (automatic) timer = setTimeout(stop, duration);
        };
        moving.onerror = () => { if (!pending.signal.aborted) stop(); };
        moving.src = source;
      } catch { if (!pending.signal.aborted) stop(); }
    };
    const check = () => {
      if (reduced.matches && mode === "auto") stop();
      if (visible && !mode && !printing && !reduced.matches && !played.has(key)) void start(true);
    };
    visibility.set(image, value => { visible = value; check(); });
    observer?.observe(image);
    checks.push(check); stops.push(stop);
    button.onclick = () => { if (mode) stop(); else void start(false); };
    link.replaceWith(button);
    cleanups.push(() => { stop(); if (note && explain) { note.hidden = true; note.style.visibility = ""; } button.replaceWith(link); });
  }
  const changed = () => { for (const check of checks) check(); };
  const beforePrint = () => { printing = true; for (const stop of stops) stop(); };
  const afterPrint = () => { printing = false; changed(); };
  reduced.addEventListener("change", changed);
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);
  return () => {
    observer?.disconnect();
    reduced.removeEventListener("change", changed);
    window.removeEventListener("beforeprint", beforePrint);
    window.removeEventListener("afterprint", afterPrint);
    for (const cleanup of cleanups) cleanup();
  };
}
