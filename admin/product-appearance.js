import {
  CARD_STYLES,
  GALLERY_LIMIT,
  galleryPath,
} from "../public/js/store/card-appearance.mjs?v=109";
import { getProductMedia } from "../public/js/store/product-media.js?v=109";
import { escapeHtml } from "./admin-core.js?v=109";

function galleryRow(path = "", index = 0, count = 1) {
  return `<div class="gallery-edit-row"><label class="gallery-path-field"><span data-gallery-position>${index + 1}. görsel</span><input aria-label="${index + 1}. görsel dosya yolu" data-gallery-path maxlength="300" placeholder="public/assets/products/gallery/contra-hax/game-01.jpeg" value="${escapeHtml(path)}"></label><button type="button" ${index === 0 ? "disabled" : ""} data-gallery-move="-1" aria-label="Bir sıra yukarı">↑</button><button type="button" ${index === count - 1 ? "disabled" : ""} data-gallery-move="1" aria-label="Bir sıra aşağı">↓</button><button type="button" data-gallery-remove aria-label="Görseli kaldır">×</button></div>`;
}
export function appearanceFields(product = {}) {
  const paths =
    product.galleryPaths ??
    getProductMedia(product)
      .filter((x) => x.kind === "game")
      .map((x) => x.src.split("?")[0]);
  const options = Object.entries(CARD_STYLES)
    .map(
      ([key, label]) =>
        `<option value="${key}"${key === product.cardStyle ? " selected" : ""}>${label}</option>`,
    )
    .join("");
  return `<fieldset class="appearance-fields"><legend>Kart ve ürün galerisi</legend><label>Kart görünümü<select data-card-style>${options}</select></label><p>Galeri sırasını oklarla değiştirin. En fazla ${GALLERY_LIMIT} yerel görsel ekleyebilirsiniz.</p><div data-gallery-list>${paths.map((path, i) => galleryRow(path, i, paths.length)).join("")}</div><div class="gallery-controls"><button type="button" ${paths.length >= GALLERY_LIMIT ? "disabled" : ""} class="secondary-action" data-gallery-add>Görsel yolu ekle</button><output data-gallery-count>${paths.length} / ${GALLERY_LIMIT}</output></div></fieldset>`;
}
export function readAppearance(form) {
  const paths = Array.from(
    form.querySelectorAll("[data-gallery-path]"),
    (el, i) => {
      const path = galleryPath(el.value);
      if (!path)
        throw Object.assign(
          new Error(
            `Galeri sırası ${i + 1} için public/assets/products altında geçerli bir görsel yolu girin.`,
          ),
          { field: el },
        );
      return path;
    },
  );
  if (new Set(paths).size !== paths.length || paths.length > GALLERY_LIMIT)
    throw new Error("Galeride en fazla 20 farklı dosya yolu kullanılabilir.");
  return {
    cardStyle: form.querySelector("[data-card-style]").value,
    galleryPaths: paths,
  };
}
export function installGalleryEditor(root = document) {
  root.addEventListener("click", (event) => {
    const button = event.target.closest(
      "[data-gallery-add],[data-gallery-move],[data-gallery-remove]",
    );
    if (!button) return;
    const field = button.closest("fieldset"),
      list = field.querySelector("[data-gallery-list]");
    const row = button.closest(".gallery-edit-row");
    if (button.hasAttribute("data-gallery-add")) {
      if (list.children.length >= GALLERY_LIMIT) return;
      list.insertAdjacentHTML("beforeend", galleryRow());
      list.lastElementChild.querySelector("input").focus();
    } else if (button.hasAttribute("data-gallery-remove")) row.remove();
    else if (button.dataset.galleryMove === "-1" && row.previousElementSibling)
      list.insertBefore(row, row.previousElementSibling);
    else if (button.dataset.galleryMove === "1" && row.nextElementSibling)
      list.insertBefore(row.nextElementSibling, row);
    [...list.children].forEach((item, index) => {
      item.querySelector("[data-gallery-position]").textContent =
        index + 1 + ". görsel";
      item
        .querySelector("input")
        .setAttribute("aria-label", index + 1 + ". görsel dosya yolu");
      item.querySelector('[data-gallery-move="-1"]').disabled = index === 0;
      item.querySelector('[data-gallery-move="1"]').disabled =
        index === list.children.length - 1;
    });
    field.querySelector("[data-gallery-count]").textContent =
      `${list.children.length} / ${GALLERY_LIMIT}`;
    field.querySelector("[data-gallery-add]").disabled =
      list.children.length >= GALLERY_LIMIT;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
