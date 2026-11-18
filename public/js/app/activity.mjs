export function createActivity({ target, indicator, status }) {
  let active = 0;
  return {
    begin(label = "Yükleniyor…") {
      const id = ++active;
      target?.setAttribute("aria-busy", "true");
      indicator?.classList.add("active");
      if (status) {
        status.hidden = false;
        status.textContent = label;
      }
      let finished = false;
      return () => {
        if (finished || id !== active) return;
        finished = true;
        target?.removeAttribute("aria-busy");
        indicator?.classList.remove("active");
        if (status) status.hidden = true;
      };
    },
    cancel() {
      active++;
      target?.removeAttribute("aria-busy");
      indicator?.classList.remove("active");
      if (status) status.hidden = true;
    },
  };
}
export function loadingCards(label = "Güncel kayıtlar yükleniyor…") {
  label = String(label).replace(
    /[&<>"\']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "\'": "&#39;",
      })[c],
  );
  return `<section class="view-skeleton" aria-label="${label}" role="status"><p><span class="spinner" aria-hidden="true"></span> ${label}</p><div class="loading-card skeleton"></div><div class="loading-card skeleton"></div><div class="loading-card skeleton"></div></section>`;
}
export function createHistoryScroll(view) {
  if ("scrollRestoration" in view.history)
    view.history.scrollRestoration = "manual";
  let frame = 0;
  function save() {
    view.history.replaceState(
      { ...view.history.state, zentraScroll: Math.max(0, view.scrollY) },
      "",
    );
  }
  const changed = () => {
    if (!frame)
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        save();
      });
  };
  view.addEventListener("scroll", changed, { passive: true });
  return {
    push(path, replace = false) {
      save();
      view.history[replace ? "replaceState" : "pushState"](
        { zentraScroll: 0 },
        "",
        path,
      );
    },
    restore(value = view.history.state?.zentraScroll) {
      const y = Number(value) || 0;
      view.scrollTo({ top: y, behavior: "instant" });
    },
    dispose() {
      view.removeEventListener("scroll", changed);
      if (frame) view.cancelAnimationFrame(frame);
    },
  };
}
