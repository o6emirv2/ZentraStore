import {
  escape as e,
  icon,
  field,
  modal,
  toast,
  busy,
} from "../public/js/app/ui.js?v=108";
import { createInventoryImport } from "./inventory-model.mjs?v=108";
const selector = (name, label, rows, value = "") =>
  `<label class="field"><span>${label}</span><select name="${name}" required>${rows.map(([id, title]) => `<option value="${e(id)}" ${id === value ? "selected" : ""}>${e(title)}</option>`).join("")}</select></label>`;
export function inventoryView(list, catalog, canWrite) {
  const products = catalog.products.filter(
    (x) => x.fulfillmentMode !== "telegram_only" && x.archived !== true,
  );
  return `<div class="admin-grid-two inventory-columns">${
    canWrite && products.length
      ? `<form id="inventory-inline-form" class="panel"><span class="eyebrow">YENİ STOK</span><h2>Toplu key / hesap ekle</h2>${selector(
          "productId",
          "Ürün / stok havuzu",
          products.map((p) => [p.id, p.name]),
        )}<div id="inventory-plan-slot">${selector(
          "planKey",
          "Paket",
          products[0].plans.map((p) => [p.key, p.label]),
        )}</div><label class="field"><span>Lisans veya hesap listesi</span><textarea name="keys" required maxlength="200000" rows="7" placeholder="Her satıra bir kayıt"></textarea></label><p class="fine-print">Lisanslarda her satıra bir key; hesaplarda kullanıcı | şifre veya username/password alanlarıyla JSON kullan. Paroladaki boşluklar için JSON biçimini seç. Kayıtlar şifrelenir.</p>${field("actionPassword", "Hesap parolanla doğrula", "password", "", 'required autocomplete="current-password"')}<p class="form-error" role="alert" hidden></p><button type="submit" class="button primary">${icon("shield")} Stoku kontrol et</button></form>`
      : `<section class="panel"><h2>Stok Kasası</h2><p>${canWrite ? "Stok eklemeye uygun otomatik teslimat ürünü bulunamadı." : "Stok görüntüleme yetkin var. Yazma işlemleri için ek yetki gerekir."}</p></section>`
  }<section class="panel"><span class="eyebrow">MEVCUT KAYITLAR</span><h2>Paket bazlı durum</h2>${list.length ? list.map((x) => `<article class="stock-row"><div><b>${e(x.productName)}</b><small>${e(x.planLabel)} · ${Number(x.delivered) || 0} teslim edildi</small></div><strong>${Number(x.available) || 0}</strong><button class="button outline small" data-admin-action="stock-list" data-product="${e(x.productId)}" data-plan="${e(x.planKey)}">Kayıtlar</button></article>`).join("") : '<p class="fine-print">Henüz stok kaydı yok.</p>'}</section></div>`;
}
export function bindInventory({
  root,
  catalog,
  api,
  ensureActive,
  reauthenticate,
  retained,
  onRetain,
  refresh,
}) {
  const form = root.querySelector("#inventory-inline-form");
  if (!form) return () => {};
  const products = catalog.products.filter(
    (p) => p.fulfillmentMode !== "telegram_only" && p.archived !== true,
  );
  const operation =
    retained?.operation ||
    createInventoryImport({ api, ensureActive, reauthenticate });
  let preview = retained?.preview || null;
  function plans() {
    const p = products.find((p) => p.id === form.elements.productId.value);
    root.querySelector("#inventory-plan-slot").innerHTML = selector(
      "planKey",
      "Paket",
      p.plans.map((x) => [x.key, x.label]),
    );
  }
  const review = () => {
    if (!preview) return;
    const p = products.find((p) => p.id === preview.productId),
      uncertain = operation.state().uncertain;
    const dlg = modal({
      title: "Stok aktarımı önizlemesi",
      submit: uncertain ? "Sonucu kontrol et" : "Stok aktarımını onayla",
      body: `<dl class="audit-fields"><div><dt>Ürün</dt><dd>${e(p?.name || preview.productId)}</dd></div><div><dt>Paket</dt><dd>${e(p?.plans.find((x) => x.key === preview.planKey)?.label || preview.planKey)}</dd></div><div><dt>Kontrol edilen</dt><dd>${preview.total}</dd></div><div><dt>Önceden kayıtlı</dt><dd>${preview.duplicateCount}</dd></div></dl><p class="fine-print">Bu kontrol stok eklemez. Son onayda kayıtlar yeniden doğrulanır.</p>${uncertain ? '<p class="notice">Önceki aktarımın kaydedilmiş sonucu okunacak; yeni aktarım gönderilmeyecek.</p>' : field("actionPassword", "Hesap parolanla onayla", "password", "", 'required autocomplete="current-password"') + '<label class="checkbox"><input type="checkbox" required/> Ürün, paket ve kayıt sayısını kontrol ettim.</label>'}`,
      onSubmit: async (data) => {
        try {
          const result = await operation.submit(
            data.get("actionPassword") || "",
          );
          ensureActive();
          onRetain(null);
          form.reset();
          toast(`${result.imported} stok kaydının aktarımı doğrulandı.`);
          void refresh();
        } catch (error) {
          onRetain({ operation, preview });
          if (operation.state().uncertain) {
            dlg.element.querySelector(".dialog-body").innerHTML =
              '<p class="notice">Aktarım sonucu henüz kesinleşmedi. Sonucu kontrol et; yeni aktarım gönderilmeyecek.</p><p class="form-error" role="alert" hidden></p>';
            const button = dlg.element.querySelector("[type=submit]");
            button.dataset.oldHtml = "Sonucu kontrol et";
          }
          throw error;
        }
      },
    });
  };
  const submit = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = form.querySelector("[type=submit]"),
      error = form.querySelector(".form-error");
    if (button.disabled) return;
    busy(button, true);
    error.hidden = true;
    try {
      ensureActive();
      if (!preview) {
        const data = new FormData(form),
          p = products.find((p) => p.id === data.get("productId"));
        const keys = String(data.get("keys"))
          .split(/\r?\n/)
          .filter((x) => x.trim())
          .map((line) => {
            if (p.inventoryType === "account" && line.trim().startsWith("{")) {
              try {
                return JSON.parse(line);
              } catch {
                throw new Error("Hesap satırındaki JSON biçimini kontrol et.");
              }
            }
            return line;
          });
        preview = await operation.prepare(
          { productId: p.id, planKey: data.get("planKey"), keys },
          data.get("actionPassword"),
        );
        onRetain({ operation, preview });
        form.elements.actionPassword.value = "";
      }
      if (form.isConnected) review();
    } catch (cause) {
      error.hidden = false;
      error.textContent = cause.message;
    } finally {
      busy(button, false);
    }
  };
  form.elements.productId.addEventListener("change", plans);
  form.addEventListener("submit", submit);
  if (preview)
    form.querySelector("[type=submit]").textContent =
      "Bekleyen aktarımı kontrol et";
  return () => {
    form.elements.productId.removeEventListener("change", plans);
    form.removeEventListener("submit", submit);
  };
}
