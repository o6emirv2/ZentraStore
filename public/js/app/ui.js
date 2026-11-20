import { isUncertainMutationError } from "../request-utils.js?v=108";
import { installTooltips } from "./tooltips.mjs?v=108";
import { createToastCenter } from "./toast-center.mjs?v=108";
import { translate } from "./preferences.mjs?v=108";
import { imageVariants } from "./images.mjs?v=108";
export const escape = (value = "") =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const money = (value) =>
  new Intl.NumberFormat(
    typeof document !== "undefined" && document.documentElement?.lang === "en"
      ? "en-GB"
      : "tr-TR",
    {
      style: "currency",
      currency: "TRY",
      maximumFractionDigits: 2,
    },
  ).format((Number(value) || 0) / 100);
export const date = (value) => {
  const number = Number(value);
  if (
    !number ||
    !Number.isFinite(number) ||
    Math.abs(number) > 8640000000000000
  )
    return "—";
  return new Intl.DateTimeFormat(
    typeof document !== "undefined" && document.documentElement?.lang === "en"
      ? "en-GB"
      : "tr-TR",
    { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Istanbul" },
  ).format(number);
};
const paths = {
  image: "M3 3h18v18H3Zm0 12 5-5 5 5 3-3 5 5M16 7h.01",
  chevron: "m9 5 7 7-7 7",
  phone: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm3 16h4",
  game: "M7 8h10a5 5 0 0 1 5 5l-1 6a2 2 0 0 1-3 1l-3-3H9l-3 3a2 2 0 0 1-3-1l-1-6a5 5 0 0 1 5-5Zm-2 5h6m-3-3v6m8-3h.1m3 2h.1",
  flame: "M12 2c2 5-3 6-1 10 1-2 4-3 5-5 5 6 5 12-1 15-10 3-16-6-8-13-1 5 2 6 3 6-2-5 3-7 2-13Z",
  sparkles: "m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5ZM20 2v4m-2-2h4",
  gift: "M3 8h18v4H3Zm2 4h14v10H5Zm7-4v14M12 8H8a3 3 0 1 1 3-3Zm0 0h4a3 3 0 1 0-3-3Z",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  success: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0m-15 0 3 3 7-7",
  error: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M8 8l8 8M8 16l8-8",
  warning: "m12 3 10 18H2Zm0 6v5m0 3v.1",
  info: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 11v6m0-10v.1",
  ticket: "M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4Zm12 0v3m0 3v2m0 3v1",
  receipt: "M5 3h14v19l-3-2-4 2-4-2-3 2Zm4 4h6M9 11h6M9 15h4",
  mail: "M3 5h18v14H3Zm0 0 9 7 9-7",
  key: "M14 7a4 4 0 1 1 0 1m-2 3L3 20l-1-1 2-2m3-3 2 2",
  history: "M3 4v5h5M3 9a9 9 0 1 1 0 7m9-9v5l3 2",
  menu: "M4 6h16M4 12h16M4 18h16",
  refresh: "M20 7V3l-4 1M20 7a9 9 0 1 0 1 9M20 7h-5",
  comment: "M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4Z",
  eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  copy: "M9 9h12v12H9zM15 9V3H3v12h6",
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  search: "m21 21-4.8-4.8M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
  bag: "M5 7h14l2 14H3ZM9 8V6a3 3 0 0 1 6 0v2",
  "user-add":
    "M15 21v-2a5 5 0 0 0-5-5H8a5 5 0 0 0-5 5v2M13 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0M19 8v6M16 11h6",
  user: "M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  heart:
    "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  back: "M20 12H4m6-6-6 6 6 6",
  down: "m6 9 6 6 6-6",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  shield: "m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6Zm-4 10 3 3 5-6",
  bolt: "m13 2-9 12h7l-1 8L21 9h-7Z",
  box: "m12 3 9 5v9l-9 5-9-5V8Zm0 9 9-4m-9 4L3 8m9 4v10m-4.5-16.5 9 5",
  support:
    "M4 14v-3a8 8 0 0 1 16 0v3M4 12H2v7h4v-7Zm16 0h2v7h-4v-7ZM19 19a4 4 0 0 1-4 3h-3",
  telegram: "m22 3-4 18-6-5-4 4 1-7 10-7-12 6-5-2Z",
  filter: "M4 7h16M7 12h10M10 17h4",
  logout: "M9 5H4v14h5m5-14 7 7-7 7m-6-7h13",
  clock: "M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  edit: "m16 3 5 5-12 12-6 1 1-6ZM13 6l5 5",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4",
  chart: "M3 3v18h18M7 15l4-5 4 3 6-8",
  settings:
    "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
  wallet: "M3 6V4h16v4H3v12h18V8H3m13 4h5v4h-5z",
  sun: "M12 3v2m0 14v2M3 12h2m14 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
};
export const icon = (name, cls = "") =>
  `<svg class="icon ${escape(cls)}" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.box}"/></svg>`;
export const brand = () =>
  '<a class="brand" href="/" aria-label="Zentra Store ana sayfa"><img class="brand-image" src="/public/assets/images/apple-touch-icon.png" alt="Zentra Store" width="192" height="192" draggable="false"/><span class="brand-text brand-wordmark" aria-hidden="true">ZENTRA STORE</span></a>';
export async function copyText(value) {
  if (!navigator.clipboard?.writeText)
    throw new Error("Bu tarayıcıda güvenli kopyalama kullanılamıyor.");
  await navigator.clipboard.writeText(String(value));
}
let toastCenter;
export function toast(message, kind = "success") {
  if (typeof document === "undefined") return;
  toastCenter ||= createToastCenter({ document, icon, escape });
  const input =
    typeof message === "object" && message
      ? message
      : { message: String(message || ""), type: kind };
  return toastCenter.push(input);
}
export function raiseToasts() {
  const region = document.getElementById("toasts");
  if (
    region?.childElementCount &&
    typeof region.showPopover === "function" &&
    region.matches(":popover-open")
  ) {
    region.hidePopover();
    region.showPopover();
  }
}
export function busy(button, value, label = "İşleniyor…") {
  if (!button) return;
  if (value) {
    if (button.getAttribute("aria-busy") === "true") return;
    button.dataset.wasDisabled = String(button.disabled);
    button.dataset.oldHtml = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${escape(label)}`;
  } else {
    button.disabled = button.dataset.wasDisabled === "true";
    delete button.dataset.wasDisabled;
    button.removeAttribute("aria-busy");
    if (button.dataset.oldHtml) button.innerHTML = button.dataset.oldHtml;
    delete button.dataset.oldHtml;
  }
}
export function modal({
  title,
  body = "",
  submit = "Kaydet",
  danger = false,
  onSubmit,
  appearance = "",
  description = "",
  symbol = "",
} = {}) {
  const previous = document.activeElement,
    dlg = document.createElement("dialog"),
    id = `dialog-${crypto.randomUUID()}`;
  dlg.className =
    "app-dialog" + (appearance === "drawer" ? " store-drawer" : appearance === "package" ? " package-dialog" : "");
  dlg.setAttribute("aria-labelledby", id);
  if (description) dlg.setAttribute("aria-describedby", id + "-description");
  dlg.innerHTML = `<form class="dialog-form"><header>${symbol ? `<span class="dialog-symbol">${icon(symbol)}</span>` : ""}<div><span class="eyebrow">ZENTRA STORE</span><h2 id="${id}">${escape(title)}</h2>${description ? `<p id="${id}-description">${escape(description)}</p>` : ""}</div><button type="button" class="icon-button" data-close aria-label="Pencereyi kapat">${icon("close")}</button></header><div class="dialog-body">${body}<p class="form-error" role="alert" hidden></p></div><footer><button type="button" class="button secondary" data-close>${onSubmit ? "Vazgeç" : "Kapat"}</button>${onSubmit ? `<button class="button ${danger ? "danger" : "primary"}" type="submit">${escape(submit)} ${icon(danger ? "warning" : "check")}</button>` : ""}</footer></form>`;
  document.body.append(dlg);
  initPasswordFields(dlg);
  document.documentElement.classList.add("dialog-open");
  dlg.showModal();
  raiseToasts();
  translate(dlg);
  let pending = false;
  const close = () => {
    if (pending) return;
    dlg.close();
    dlg.remove();
    if (!document.querySelector("dialog[open]"))
      document.documentElement.classList.remove("dialog-open");
    previous?.isConnected && previous.focus({ preventScroll: true });
  };
  dlg
    .querySelectorAll("[data-close]")
    .forEach((b) => b.addEventListener("click", close));
  dlg.addEventListener("click", (event) => {
    if (event.target.closest("a[data-nav]")) {
      if (pending) {
        event.preventDefault();
        event.stopPropagation();
      } else close();
    }
  });
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  const navigationClose = () => close();
  window.addEventListener("popstate", navigationClose);
  dlg.addEventListener("close", () => window.removeEventListener("popstate", navigationClose), { once: true });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        close();
    }
  });
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pending || !onSubmit) return;
    pending = true;
    const button = dlg.querySelector("[type=submit]"),
      error = dlg.querySelector(".form-error");
    error.hidden = true;
    busy(button, true);
    dlg.querySelectorAll("[data-close]").forEach(control => control.disabled = true);
    try {
      const result = await onSubmit(new FormData(e.target), e.target);
      pending = false;
      if (result !== false) close();
    } catch (err) {
      pending = false;
      const currentError = dlg.querySelector(".form-error") || error;
      const uncertain =
        isUncertainMutationError(err) ||
        err?.code === "RECOVERY_RESULT_UNCERTAIN" ||
        err?.resultUncertain === true;
      currentError.innerHTML = `${icon(uncertain ? "warning" : "error")}<span>${escape(err.message || "İşlem tamamlanamadı.")}</span>`;
      currentError.classList.toggle("uncertain", uncertain);
      currentError.hidden = false;
      currentError.tabIndex = -1;
      currentError.focus();
    } finally {
      busy(button, false);
      dlg.querySelectorAll("[data-close]").forEach(control => control.disabled = false);
    }
  });
  return { element: dlg, close };
}
export const empty = (
  title,
  message,
  link = "/magaza",
  label = "Ürünleri keşfet",
) =>
  `<div class="empty-state">${icon("box")}<h2>${escape(title)}</h2><p>${escape(message)}</p>${link ? `<a class="button primary" href="${escape(link)}" data-nav>${escape(label)} ${icon("arrow")}</a>` : ""}</div>`;
export const field = (name, label, type = "text", value = "", extra = "", symbol = "") => {
  const password = type === "password";
  const decorated = ["password", "email", "text", "search"].includes(type);
  const id = "input-" + crypto.randomUUID();
  const input = `<input id="${id}" name="${escape(name)}" type="${escape(type)}" value="${escape(value)}" ${password ? "data-password-input" : ""} ${extra}/>`;
  return `<div class="field"><label for="${id}">${escape(label)}</label>${decorated ? `<span class="input-shell">${icon(symbol || (password ? "key" : type === "search" ? "search" : type === "email" ? "mail" : "user"))}${input}${password ? `<button type="button" class="password-toggle" data-password-toggle aria-label="Şifreyi göster" aria-pressed="false">${icon("eye")}</button>` : ""}</span>` : input}</div>`;
};
export function initPasswordFields(root) {
  installTooltips(
    root.ownerDocument || (typeof document !== "undefined" ? document : null),
  );
  for (const button of root.querySelectorAll?.("[data-password-toggle]") ||
    []) {
    button.onclick = (event) => {
      event.preventDefault();
      const input = button.parentElement.querySelector("input");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.setAttribute(
        "aria-label",
        show ? "Şifreyi gizle" : "Şifreyi göster",
      );
      button.setAttribute("aria-pressed", String(show));
    };
  }
}
export const statusNames = {
  awaiting_payment: "Ödeme bekliyor",
  payment_review: "Ödeme inceleniyor",
  payment_rejected: "Ödeme reddedildi",
  paid: "Ödeme onaylandı",
  processing: "Hazırlanıyor",
  delivery_pending: "Teslimat bekliyor",
  delivered: "Teslim edildi",
  cancelled: "İptal edildi",
  refunded: "İade tamamlandı",
};
export const status = (value) =>
  `<span class="status-pill ${["delivered", "paid"].includes(value) ? "green" : ["cancelled", "payment_rejected"].includes(value) ? "red" : "amber"}">${escape(statusNames[value] || value || "Bekliyor")}</span>`;
export function safeImage(value = "") {
  const fallback = "/public/assets/images/zentra-mark.webp";
  if (typeof value !== "string") return fallback;
  if (imageVariants[value]) return imageVariants[value];
  if (
    /^\/public\/assets\/[a-zA-Z0-9._/-]+$/.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  )
    return value;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.hostname === "firebasestorage.googleapis.com" &&
      !url.username &&
      !url.password &&
      !url.port
    )
      return url.href;
  } catch {}
  return fallback;
}
