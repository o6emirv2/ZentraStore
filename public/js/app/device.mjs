const installed = new WeakMap();
const editable = "input, textarea, [contenteditable], [role='textbox']";
const protectedControl =
  "a, button, summary, [role='button'], img, svg, .delivery-secret";
export function installDevicePolicy(doc, view) {
  if (!doc?.addEventListener || !view) return () => {};
  if (installed.has(doc)) return installed.get(doc);
  let touched = false;
  const listeners = [];
  const on = (name, handler, options) => {
    doc.addEventListener(name, handler, options);
    listeners.push([name, handler, options]);
  };
  const mark = () => {
    touched = true;
    if (doc.documentElement) doc.documentElement.dataset.touchInput = "true";
  };
  on(
    "pointerdown",
    (event) => {
      if (event.pointerType === "touch") mark();
      else if (event.pointerType === "mouse") {
        touched = false;
        if (doc.documentElement) delete doc.documentElement.dataset.touchInput;
      }
    },
    { passive: true },
  );
  on("touchstart", mark, { passive: true });
  for (const name of ["contextmenu", "selectstart", "dragstart", "dblclick"])
    on(
      name,
      (event) => {
        const target =
          typeof event.target?.closest === "function"
            ? event.target
            : event.target?.parentElement;
        if (
          (touched ||
            view.matchMedia?.("(pointer: coarse)")?.matches === true) &&
          target?.closest(protectedControl) &&
          !target.closest(editable) &&
          event.cancelable
        )
          event.preventDefault();
      },
      { passive: false },
    );
  const remove = () => {
    for (const [name, handler, options] of listeners)
      doc.removeEventListener(name, handler, options);
    if (doc.documentElement) delete doc.documentElement.dataset.touchInput;
    installed.delete(doc);
  };
  installed.set(doc, remove);
  return remove;
}
