const installed = new WeakSet();
export function installTooltips(doc) {
  if (!doc?.body?.append || installed.has(doc)) return;
  installed.add(doc);
  const tip = doc.createElement("div");
  tip.id = "zentra-icon-tooltip";
  tip.className = "icon-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  doc.body.append(tip);
  let owner;
  const hide = () => {
    tip.hidden = true;
    if (typeof tip.hidePopover === "function" && tip.matches(":popover-open"))
      tip.hidePopover();
    if (owner) {
      const ids = (owner.getAttribute("aria-describedby") || "")
        .split(" ")
        .filter((id) => id && id !== tip.id);
      ids.length
        ? owner.setAttribute("aria-describedby", ids.join(" "))
        : owner.removeAttribute("aria-describedby");
      owner = null;
    }
  };
  const show = (event) => {
    if (event.type === "pointerover" && event.pointerType !== "mouse") return;
    const target = event.target.closest?.(
      ".icon-button[aria-label], .password-toggle[aria-label]",
    );
    if (!target || target === owner) return;
    hide();
    owner = target;
    tip.textContent = target.getAttribute("aria-label");
    target.setAttribute(
      "aria-describedby",
      [target.getAttribute("aria-describedby"), tip.id]
        .filter(Boolean)
        .join(" "),
    );
    tip.hidden = false;
    if (typeof tip.showPopover === "function") {
      tip.setAttribute("popover", "manual");
      tip.showPopover();
    }
    const box = target.getBoundingClientRect(),
      size = tip.getBoundingClientRect(),
      view = doc.defaultView;
    tip.style.left =
      Math.max(
        8,
        Math.min(
          view.innerWidth - size.width - 8,
          box.left + box.width / 2 - size.width / 2,
        ),
      ) + "px";
    tip.style.top =
      (box.top > size.height + 16
        ? box.top - size.height - 8
        : box.bottom + 8) + "px";
  };
  doc.addEventListener("pointerover", show);
  doc.addEventListener("focusin", show);
  doc.addEventListener("pointerout", (event) => {
    if (owner && !owner.contains(event.relatedTarget)) hide();
  });
  doc.addEventListener("focusout", hide);
  doc.addEventListener("pointerdown", hide);
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  doc.defaultView.addEventListener("scroll", hide, {
    passive: true,
    capture: true,
  });
}
