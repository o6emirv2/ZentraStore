import { adminLayout } from "/admin/layout.mjs?v=108";
import { productCards } from "/admin/product-view.mjs?v=108";
import { openProductEditor } from "/admin/product-editor.mjs?v=108";
import { modal, field } from "/public/js/app/ui.js?v=108";
const root = document.querySelector("#preview-root");
root.innerHTML = adminLayout({ email: "gorunum@zentra.invalid", role: "Salt okunur görünüm kontrolü", permissions: ["*"] });
const catalog = await fetch("/api/store/catalog").then(res => res.json()).then(data => data.catalog);
const main = root.querySelector("main");
main.innerHTML = '<p class="notice" role="status">Salt okunur görünüm kontrolü. Örnek katalog; gerçek yönetici oturumu ve kayıt işlemi yoktur.</p><header class="admin-view-header"><div><span class="eyebrow">ZENTRA YÖNETİM MERKEZİ</span><h1>Ürünler.</h1><p>Ürün kartları ve ekleme/düzenleme formları.</p></div><button class="button secondary" data-preview-create>Ürün ekle</button></header>' + productCards(catalog.products, true);
function open(product) {
  openProductEditor({ product, badgeOptions: catalog.badgeOptions, mutation: options => {
    const dialog = modal({ ...options, body: '<p class="notice">Görünüm kontrolü · Kaydetme kapalı</p>' + options.body + (options.requiresPassword ? field("actionPassword", "Hesap şifrenle işlemi doğrula", "password", "", 'autocomplete="off" disabled') : ""),
      onSubmit: () => { throw new Error("Salt okunur görünüm; kayıt gönderilemez."); } });
    const submit = dialog.element.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Kaydet · Önizlemede kapalı";
    return dialog;
  } });
}
root.addEventListener("click", event => {
  if (event.target.closest("[data-preview-create]")) return open();
  const button = event.target.closest('[data-admin-action="product-edit"]');
  if (button) open(catalog.products.find(p => p.id === button.dataset.id));
});
const form = new URLSearchParams(location.search).get("form");
if (form === "create") open();
else if (form === "edit") open(catalog.products[0]);
