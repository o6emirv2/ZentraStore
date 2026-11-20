import {
  modal,
  field,
  escape as e,
  money,
  date,
  toast,
  initPasswordFields,
} from "../public/js/app/ui.js?v=108";
import { createWalletOperation } from "./wallet-model.mjs?v=108";
let retained = null;
export function clearWalletState() {
  retained = null;
}
export function openWalletDialog({
  api,
  actorUid,
  ensureActive,
  reauthenticate,
  refresh,
  identifier = "",
}) {
  if (retained?.actorUid !== actorUid) retained = null;
  const operation =
    retained?.operation ||
    createWalletOperation({ api, reauthenticate, ensureActive });
  let review = operation.snapshot(),
    inFlight = false;
  const label = (text) => {
    const button = dlg.element.querySelector("[type=submit]");
    button.textContent = text;
    if (button.dataset.oldHtml) button.dataset.oldHtml = text;
  };
  const inputs = (value = {}) =>
    `<p class="fine-print">Kullanıcı adı veya e-posta ile hesabı bul. UID ile tam eşleşen arama da desteklenir. Hesap ve bakiye işleminden önce önizleme gösterilir.</p>${field("identifier", "Kullanıcı adı veya e-posta", "text", value.identifier || "", 'required maxlength="254" autocomplete="off" autocapitalize="none" spellcheck="false"')}<label class="field"><span>İşlem türü</span><select name="type"><option value="credit" ${value.type !== "debit" ? "selected" : ""}>Bakiye ekle</option><option value="debit" ${value.type === "debit" ? "selected" : ""}>Bakiye düş</option></select></label>${field("amount", "Tutar (₺)", "text", value.amount || "", 'required inputmode="decimal" maxlength="12" placeholder="5000 veya 5000,50"')}${field("reason", "İşlem gerekçesi", "text", value.reason || "", 'required minlength="6" maxlength="200"')}`;
  const dlg = modal({
    title: "Bakiye işlemi",
    submit: review ? "Sonucu kontrol et" : "Hesabı bul ve önizle",
    body: review ? "" : inputs({ identifier }),
    onSubmit: async (data, form) => {
      if (inFlight) return false;
      inFlight = true;
      try {
        ensureActive();
        if (!review) {
          review = await operation.prepare(Object.fromEntries(data));
          if (!form.isConnected) throw new Error("İşlem penceresi değişti.");
          showReview();
          return false;
        }
        const result = await operation.submit(data.get("actionPassword") || "");
        ensureActive();
        retained = null;
        toast(
          `Bakiye işlemi kayıttan doğrulandı. İşlem sonrası bakiye: ${money(result.balanceAfterKurus)}`,
        );
        void refresh();
      } catch (error) {
        if (operation.snapshot()?.uncertain) {
          retained = { actorUid, operation };
          const note = dlg.element.querySelector(".wallet-pending");
          if (note) note.hidden = false;
          label("Sonucu kontrol et");
          const edit = dlg.element.querySelector("[data-wallet-edit]");
          if (edit) edit.disabled = true;
          const password = dlg.element.querySelector("[name=actionPassword]");
          if (password) {
            password.value = "";
            password.required = false;
            password.disabled = true;
          }
        }
        throw error;
      } finally {
        inFlight = false;
      }
    },
  });
  dlg.element.classList.add("wallet-dialog");
  function showReview() {
    const value = operation.snapshot(),
      p = value.payload,
      user = value.recipient;
    dlg.element.querySelector(".dialog-body").innerHTML =
      `<div class="notice wallet-recipient"><strong>İşlem yapılacak hesap</strong><p>${e(user.fullName || user.username || "Müşteri")}<br>${e(user.username)}<br>${e(user.email)}</p><small>UID: ${e(user.uid)}</small></div><dl class="audit-fields wallet-summary"><div><dt>Mevcut bakiye</dt><dd>${money(user.balanceKurus)}</dd></div><div><dt>${p.amountKurus > 0 ? "Eklenecek" : "Düşülecek"} tutar</dt><dd>${money(Math.abs(p.amountKurus))}</dd></div><div><dt>İşlem sonrası bakiye</dt><dd>${money(user.balanceKurus + p.amountKurus)}</dd></div><div><dt>Gerekçe</dt><dd>${e(p.reason)}</dd></div></dl><p class="fine-print">Önizleme ${date(value.expiresAt)} tarihine kadar geçerlidir. Bakiye değişirse yeni önizleme gerekir.</p><p class="notice wallet-pending" ${value.uncertain ? "" : "hidden"}>Bir işlem gönderildi. Yeniden bakiye eklemeden kayıtlı sonucu kontrol et.</p>${field("actionPassword", "Hesap şifrenle işlemi doğrula", "password", "", value.uncertain ? 'disabled autocomplete="current-password"' : 'required autocomplete="current-password"')}<label class="checkbox"><input name="confirmed" type="checkbox" required ${value.uncertain ? "checked disabled" : ""}>Hesabı, tutarı ve işlem türünü kontrol ettim.</label><button type="button" class="text-button" data-wallet-edit ${value.uncertain ? "disabled" : ""}>Bilgileri düzenle</button><p class="form-error" role="alert" hidden></p>`;
    label(value.uncertain ? "Sonucu kontrol et" : "Bakiyeyi onayla");
    initPasswordFields(dlg.element);
  }
  dlg.element.addEventListener("click", (event) => {
    if (
      !event.target.closest("[data-wallet-edit]") ||
      inFlight ||
      operation.snapshot()?.uncertain
    )
      return;
    const previous = review?.intent;
    review = null;
    dlg.element.querySelector(".dialog-body").innerHTML =
      inputs(previous) + '<p class="form-error" role="alert" hidden></p>';
    label("Hesabı bul ve önizle");
  });
  if (review) showReview();
  return dlg;
}
