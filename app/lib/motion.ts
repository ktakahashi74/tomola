// Upgrade the ordinary no-JS link in place. No animation URL enters an image
// source, preload or prefetch until the reader explicitly presses the button.
export function activateMotionFigures(root: HTMLElement) {
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[data-motion-open]")) {
    const figure = link.closest<HTMLElement>("[data-motion-figure]")!, image = figure.querySelector<HTMLImageElement>("img");
    if (!image) continue;
    const url = link.getAttribute("href")!, show = link.textContent!, back = link.dataset.motionBack!;
    const button = document.createElement("button");
    button.type = "button"; button.className = "underline cursor-pointer"; button.textContent = show;
    let still = "", moving = false;
    button.onclick = () => {
      if (!moving) still = image.getAttribute("src")!;
      moving = !moving;
      image.setAttribute("src", moving ? url : still);
      button.textContent = moving ? back : show;
      const translated = figure.querySelector<HTMLElement>("[data-translated-figure]");
      figure.querySelector<HTMLElement>("[data-motion-note]")?.toggleAttribute("hidden", !moving || !translated || translated.dataset.figureTranslated === translated.dataset.figureOriginal);
      for (const element of figure.querySelectorAll<HTMLElement>("[data-figure-toggle], [data-figure-fallback]")) {
        if (moving) { element.dataset.motionHidden = String(element.hidden); element.hidden = true; }
        else { element.hidden = element.dataset.motionHidden === "true"; delete element.dataset.motionHidden; }
      }
    };
    link.replaceWith(button);
  }
}
