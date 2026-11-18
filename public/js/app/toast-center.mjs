const kinds = new Set([
  "success",
  "error",
  "warning",
  "uncertain",
  "info",
  "pending",
]);
export function createToastQueue({
  change,
  schedule = setTimeout,
  cancel = clearTimeout,
  limit = 3,
} = {}) {
  const items = [];
  let sequence = 0;
  function publish() {
    const visible = items.slice(0, limit);
    for (const item of visible) {
      if (!item.timer && !item.persistent)
        item.timer = schedule(() => remove(item.id), item.duration);
    }
    change?.(visible.map(({ timer, ...item }) => item));
  }
  function remove(id) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return;
    cancel(items[index].timer);
    items.splice(index, 1);
    publish();
  }
  function push(input) {
    const type = kinds.has(input.type) ? input.type : "info";
    const key = input.key || type + ":" + input.message;
    const old = items.find((item) => item.key === key);
    if (old) {
      old.count++;
      publish();
      return old.id;
    }
    const item = {
      ...input,
      type,
      key,
      id: ++sequence,
      count: 1,
      persistent:
        input.persistent ?? ["error", "uncertain", "pending"].includes(type),
      duration: Math.max(6000, Number(input.duration) || 7000),
    };
    items.push(item);
    publish();
    return item.id;
  }
  return {
    push,
    remove,
    clear() {
      items.splice(0).forEach((item) => cancel(item.timer));
      change?.([]);
    },
  };
}
export function createToastCenter({ document: doc, icon, escape: e }) {
  const nodes = new Map();
  const labels = {
    success: "İşlem tamamlandı",
    error: "İşlem tamamlanamadı",
    warning: "Bilgilerini kontrol et",
    uncertain: "Sonuç doğrulanıyor",
    info: "Bilgilendirme",
    pending: "İşlem sürüyor",
  };
  const icons = {
    success: "success",
    error: "error",
    warning: "warning",
    uncertain: "warning",
    info: "info",
    pending: "clock",
  };
  const queue = createToastQueue({
    change(items) {
      const region = doc.getElementById("toasts");
      if (!region) return;
      if (typeof region.showPopover === "function") {
        region.setAttribute("popover", "manual");
        if (items.length && !region.matches(":popover-open"))
          region.showPopover();
        else if (!items.length && region.matches(":popover-open"))
          region.hidePopover();
      }
      region.setAttribute("aria-label", "İşlem bildirimleri");
      for (const [id, node] of nodes)
        if (!items.some((item) => item.id === id)) {
          node.remove();
          nodes.delete(id);
        }
      for (const item of items) {
        let node = nodes.get(item.id);
        if (!node) {
          node = doc.createElement("article");
          node.className = "toast " + item.type;
          node.setAttribute("role", item.type === "error" ? "alert" : "status");
          node.setAttribute("aria-atomic", "true");
          node.innerHTML = `${icon(icons[item.type])}<div class="toast-copy"><b>${e(item.title || labels[item.type])}</b><p>${e(item.message)}</p>${item.action ? '<button type="button" class="toast-action"></button>' : ""}<small class="toast-repeat" hidden></small></div><button type="button" class="toast-dismiss" aria-label="Bildirimi kapat">${icon("close")}</button>`;
          node
            .querySelector(".toast-dismiss")
            .addEventListener("click", () => queue.remove(item.id));
          if (item.action) {
            const button = node.querySelector(".toast-action");
            button.textContent = item.action.label;
            button.addEventListener("click", async () => {
              if (button.disabled) return;
              button.disabled = true;
              try {
                await item.action.run();
              } catch (error) {
                queue.push({
                  type: "error",
                  message: error.message || "İşlem tamamlanamadı.",
                });
              } finally {
                button.disabled = false;
              }
            });
          }
          nodes.set(item.id, node);
          region.append(node);
        }
        const repeat = node.querySelector(".toast-repeat");
        repeat.hidden = item.count < 2;
        repeat.textContent = `${item.count} aynı bildirim birleştirildi`;
      }
    },
  });
  return queue;
}
