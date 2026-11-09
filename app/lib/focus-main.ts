export function focusMain() {
  const main = document.querySelector("main");
  if (!main) return;
  const blur = () => main.blur();
  main.tabIndex = -1;
  main.addEventListener("blur", () => {
    main.removeAttribute("tabindex");
    main.removeEventListener("pointerdown", blur);
  }, { once: true });
  // A pointer press inside an already-focused main must also release it.
  main.addEventListener("pointerdown", blur, { once: true });
  main.focus({ preventScroll: true });
}
