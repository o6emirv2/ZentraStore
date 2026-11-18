const screens = new WeakMap();

export async function presentScreen(
  element,
  markup,
  { isCurrent = () => true, animate = true } = {},
) {
  const previous = screens.get(element);
  previous?.animation?.cancel();
  const state = { animation: null };
  screens.set(element, state);
  const current = () =>
    screens.get(element) === state &&
    isCurrent() &&
    element.isConnected !== false;
  // Keep navigation and identity invalidation ahead of a queued presentation.
  await Promise.resolve();
  if (!current()) return false;
  const doc = element.ownerDocument,
    view = doc.defaultView;
  const reduced =
    doc.documentElement?.dataset?.motion === "reduce" ||
    view?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  element.classList?.remove("view-enter");
  element.innerHTML = markup;
  if (animate && !reduced && doc.visibilityState !== "hidden") {
    try {
      if (typeof element.animate === "function") {
        const animation = element.animate(
          [
            { opacity: 0.55, transform: "translateY(8px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
        state.animation = animation;
        Promise.resolve(animation.finished)
          .catch(() => {})
          .finally(() => {
            if (screens.get(element) === state) state.animation = null;
          });
      } else {
        view?.requestAnimationFrame?.(() => {
          if (current()) element.classList?.add("view-enter");
        });
      }
    } catch {
      /* Presentation stays usable when motion is unavailable. */
    }
  }
  return true;
}
