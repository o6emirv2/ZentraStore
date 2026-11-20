import { escape as e, field as baseField, icon, toast } from "../public/js/app/ui.js?v=108";
import { CATEGORY_PRESETS } from "../public/js/store/catalog-schema.mjs";
import { prepareProductImage } from "./product-image-upload.js?v=108";
import { productPlans, productSortOrder } from "./product-model.mjs?v=108";
const field = (name, label, type, value, extra = "") => baseField(name, label, type, value, extra,
  ({ id: "grid", name: "box", image: "image", price: "wallet", planKey: "ticket", planLabel: "ticket", duration: "clock" })[name] || "box");

const area = (name, label, value = "", attrs = "") =>
  `<label class="field"><span>${e(label)}</span><textarea name="${e(name)}" rows="3" ${attrs}>${e(value)}</textarea></label>`;
const select = (name, label, options, value) => {
  const id = "product-" + crypto.randomUUID();
  return `<div class="field"><label for="${id}">${e(label)}</label><select id="${id}" name="${e(name)}">${options.map(([key, text]) => `<option value="${e(key)}" ${key === value ? "selected" : ""}>${e(text)}</option>`).join("")}</select></div>`;
};
const toggle = (name, label, checked, disabled = false) =>
  `<label class="product-toggle"><span>${e(label)}</span><input type="checkbox" name="${e(name)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}/></label>`;

function planRow(plan = {}, creating = false, index = 0) {
  return `<fieldset class="product-plan" data-product-plan><legend>${creating ? "Paket bilgileri" : e(plan.label)}</legend>${creating ? `<div class="product-plan-heading">${field("planKey", "Paket kodu", "text", plan.key || "", 'required pattern="[a-z][a-z0-9-]{0,39}" maxlength="40"')}${index ? `<button type="button" class="icon-button" data-product-editor="remove-plan" aria-label="Bu paketi kaldır">${icon("close")}</button>` : ""}</div>` : `<p class="fine-print">Paket kodu: ${e(plan.key)}</p>`}<div class="field-row">${field("planLabel", "Paket adı", "text", plan.label || "", 'required maxlength="50"')}${field("duration", "Paket süresi", "text", plan.duration || "", 'required maxlength="50"')}</div>${field("price", "Paket fiyatı (₺)", "text", plan.priceKurus ? (plan.priceKurus / 100).toFixed(2) : "", 'required inputmode="decimal" maxlength="10" placeholder="Örnek: 300,50"')}${plan.active === false ? '<p class="fine-print">Bu paket satışa kapalıdır; fiyat düzenlemesi paketi yayımlamaz.</p>' : ""}</fieldset>`;
}

export function productEditorBody(product, badgeOptions = []) {
  const creating = !product, p = product || {}, telegramOnly = p.immutableFulfillment === true || p.game === "gbox";
  const plans = p.plans || [{ key: "daily", label: "Günlük", duration: "24 Saat", priceKurus: 10000 }];
  return `<div class="product-editor" data-product-editor-mode="${creating ? "create" : "edit"}"><fieldset class="product-editor-section"><legend>Ürün bilgileri</legend>${creating ? field("id", "Ürün kodu", "text", "", 'required pattern="[a-z][a-z0-9-]{2,63}" maxlength="64" placeholder="Örnek: yeni-urun"') : `<p class="fine-print">Ürün kodu: ${e(p.id)} · Mevcut sipariş ve stok bağlantıları korunur.</p>`}${field("name", "Ürün adı", "text", p.name || "", 'required minlength="3" maxlength="80"')}${area("description", "Ürün açıklaması", p.description || "", 'required minlength="8" maxlength="240"')}${creating ? `<div class="field-row">${select("categoryKey", "Kategori", Object.entries(CATEGORY_PRESETS).map(([key, value]) => [key, value.category]), "pubg-android")}${select("fulfillmentMode", "Teslimat", [["automatic", "Otomatik + Telegram"], ["telegram_only", "Yalnız Telegram"]], "automatic")}</div>${select("inventoryType", "Stok türü", [["license", "Lisans anahtarı"], ["account", "Hesap bilgileri"]], "license")}` : ""}${field("image", "Görsel dosya yolu", "text", p.image || "", 'maxlength="500" placeholder="/public/assets/products/urun.webp"')}<details class="product-image-option"><summary>Alternatif: görsel dosyası yükle</summary><label class="field"><span>Ürün görseli</span><input name="imageFile" type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/gif"/></label><p class="fine-print">Dosya seçersen görsel sunucuda doğrulanarak kaydedilir.</p></details>${area("features", "Ürün özellikleri", (p.features || []).join("\n"), 'maxlength="6500" placeholder="Her satıra bir özellik yaz."')}${select("badgeKey", "Ürün rozeti", (badgeOptions.length ? badgeOptions : [{ key: "premium", label: "Premium" }]).map(b => [b.key, b.label]), p.badgeKey || "premium")}${field("sortOrder", "Ürün sırası", "number", p.sortOrder ?? 500, 'required min="0" max="10000" step="1" inputmode="numeric"')}<p class="fine-print">0–10000 arasında tam sayı. Küçük değer mağazanın önerilen sıralamasında önce gösterilir. Aynı sıradaki ürünler ada göre dizilir.</p></fieldset><fieldset class="product-editor-section"><legend>Paket fiyatları</legend><p class="fine-print">Fiyatlar Türk lirasıdır. Her paketin adı, süresi ve fiyatı birlikte kaydedilir.</p><div data-product-plans>${plans.map((plan, i) => planRow(plan, creating, i)).join("")}</div>${creating ? `<button type="button" class="button secondary" data-product-editor="add-plan">${icon("plus")}<span>Yeni paket ekle</span></button>` : ""}</fieldset><fieldset class="product-editor-section"><legend>${creating ? "Mağaza görünürlüğü" : "Yayın ve satış ayarları"}</legend><div class="product-toggle-grid">${creating ? "" : toggle("active", "Ürün yayında", p.active !== false) + toggle("archived", "Ürünü arşivle", p.archived === true) + toggle("automaticEnabled", "Otomatik satışa açık", !telegramOnly && p.automaticEnabled !== false, telegramOnly) + toggle("telegramEnabled", "Telegram satışına açık", telegramOnly || p.telegramEnabled !== false, telegramOnly)}${toggle("featured", "Öne çıkan ürün", p.featured === true)}</div>${telegramOnly ? '<p class="fine-print">Bu ürün yalnızca Telegram ile teslim edilir; otomatik satış açılamaz.</p>' : ""}<p class="fine-print">${creating ? "Yeni ürün ekleme, hesap parolanla doğrulanır." : "Düzenleme, açık yönetici oturumun ve ürün yönetimi yetkinle doğrulanır. Yeniden hesap parolası istenmez."}</p></fieldset></div>`;
}

export function openProductEditor({ product, badgeOptions, mutation }) {
  const creating = !product;
  const dialog = mutation({
    title: creating ? "Yeni ürün ekle" : product.name + " · Ürünü düzenle",
    url: creating ? "/api/admin/store/products" : "/api/admin/store/products/" + encodeURIComponent(product.id),
    method: creating ? "POST" : "PATCH",
    requiresPassword: creating,
    body: productEditorBody(product, badgeOptions),
    build: async (data, form) => {
      const rows = [...form.querySelectorAll("[data-product-plan]")].map(node => ({
        key: node.querySelector("[name=planKey]")?.value,
        label: node.querySelector("[name=planLabel]").value,
        duration: node.querySelector("[name=duration]").value,
        price: node.querySelector("[name=price]").value,
      }));
      const plans = productPlans(rows, { creating, previous: product?.plans || [] });
      const sortOrder = productSortOrder(data.get("sortOrder"));
      const file = form.querySelector("[name=imageFile]").files[0];
      const imageUpload = file ? await prepareProductImage(file) : null;
      const value = {
        name: String(data.get("name") || "").trim(), description: String(data.get("description") || "").trim(),
        image: String(data.get("image") || "").trim(),
        features: String(data.get("features") || "").split("\n").map(line => line.trim()).filter(Boolean),
        badgeKey: data.get("badgeKey"), sortOrder, featured: data.has("featured"),
        ...(imageUpload ? { imageUpload } : {}),
      };
      if (creating) {
        const categoryKey = data.get("categoryKey"), category = CATEGORY_PRESETS[categoryKey];
        if (!category) throw new Error("Geçerli bir ürün kategorisi seç.");
        return { ...value, id: data.get("id"), categoryKey, platform: category.platform, game: category.game,
          inventoryType: data.get("inventoryType"), fulfillmentMode: category.game === "gbox" ? "telegram_only" : data.get("fulfillmentMode"), plans };
      }
      const telegramOnly = product.immutableFulfillment === true || product.game === "gbox";
      return { ...value, active: data.has("active"), archived: data.has("archived"),
        automaticEnabled: !telegramOnly && data.has("automaticEnabled"), telegramEnabled: telegramOnly || data.has("telegramEnabled"),
        plans: Object.fromEntries(plans.map(plan => [plan.key, plan])) };
    },
  });
  const form = dialog.element.querySelector("form");
  form.addEventListener("click", event => {
    const control = event.target.closest("[data-product-editor]");
    if (!control || form.querySelector('[type="submit"]').disabled) return;
    if (control.dataset.productEditor === "add-plan") {
      const list = form.querySelector("[data-product-plans]"), count = list.children.length;
      if (count >= 12) return toast("En fazla 12 paket eklenebilir.", "warning");
      list.insertAdjacentHTML("beforeend", planRow({}, true, count));
      list.lastElementChild.querySelector("input").focus();
    } else {
      control.closest("[data-product-plan]").remove();
      form.querySelector('[data-product-editor="add-plan"]').focus();
    }
  });
  form.addEventListener("change", event => {
    if (event.target.name !== "categoryKey") return;
    const select = form.elements.fulfillmentMode, telegramOnly = CATEGORY_PRESETS[event.target.value]?.game === "gbox";
    select.disabled = telegramOnly;
    if (telegramOnly) select.value = "telegram_only";
  });
  return dialog;
}
