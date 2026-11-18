import {
  escape as e,
  field,
  icon,
  money,
  date,
  busy,
} from "../public/js/app/ui.js?v=108";

export function walletView(summary, canWrite) {
  return `<section class="stat-grid"><article class="stat-card"><header>Toplam müşteri bakiyesi</header><div class="stat-number">${money(summary.liabilityKurus)}</div><small>${summary.profileComplete === false ? "Kısmi hesap kapsamı" : "Sorgulanan hesaplar"}</small></article><article class="stat-card"><header>Bakiyesi bulunan hesaplar</header><div class="stat-number">${Number(summary.fundedAccounts) || 0}</div></article></section><div class="admin-grid-two"><section class="panel"><span class="eyebrow">HESAP SORGULA</span><h2>Müşteri bakiye merkezi</h2>${canWrite ? `<form id="wallet-customer-search">${field("identifier", "Kullanıcı adı, e-posta veya UID", "search", "", 'required maxlength="254" autocomplete="off" autocapitalize="none" spellcheck="false"')}<p class="form-error" role="alert" hidden></p><button class="button secondary" type="submit">${icon("search")} Hesabı bul</button></form><div id="wallet-customer-result" aria-live="polite"></div>` : "<p>Kesin hesap sorgulaması için bakiye işlemi yetkisi gerekir.</p>"}<p class="fine-print">Hesap sorgulaması bakiye değiştirmez. Tutar, müşteri ve işlem sonrası bakiye ayrıca onaylanır.</p></section><section class="panel"><span class="eyebrow">FİNANSAL KAYITLAR</span><h2>Hesap hareketleri</h2><div id="wallet-ledger-result" aria-live="polite"><p class="fine-print">Bir müşteri seçtiğinde gerçek bakiye defteri burada gösterilir.</p></div></section></div><section class="panel"><h2>Promosyon kodları</h2><p class="fine-print">Bakiye kodlarını ayrı bölümden yönetebilirsin. Kullanım ve tutarlar sunucuda doğrulanır.</p><a class="button outline small" href="#panel/promocodes">Promosyon Kodları ${icon("arrow")}</a></section>`;
}
export function ledgerView(rows, nextCursor = "") {
  return `${rows.length ? rows.map((row) => `<article class="audit-card"><header><b>${row.amountKurus >= 0 ? "+" : "−"}${money(Math.abs(row.amountKurus))}</b><time>${date(row.createdAt)}</time></header><p>${e(row.reason || row.type)}</p><dl class="audit-fields"><div><dt>Önceki bakiye</dt><dd>${money(row.balanceBeforeKurus)}</dd></div><div><dt>Sonraki bakiye</dt><dd>${money(row.balanceAfterKurus)}</dd></div><div><dt>İşlem kimliği</dt><dd>${e(row.transactionId)}</dd></div></dl></article>`).join("") : '<p class="fine-print">Bu hesapta kayıtlı bakiye hareketi bulunmuyor.</p>'}${nextCursor ? '<button type="button" class="button outline small" data-wallet-next>Sonraki hareketler</button>' : ""}`;
}
export function bindWallet({ root, api, ensureActive, onAdjust }) {
  const form = root.querySelector("#wallet-customer-search");
  if (!form) return () => {};
  let active = true,
    recipient = null,
    cursor = "",
    requestId = 0;
  const output = root.querySelector("#wallet-customer-result"),
    ledger = root.querySelector("#wallet-ledger-result");
  const current = (id) => {
    if (!active || !form.isConnected || id !== requestId) return false;
    try {
      ensureActive();
      return true;
    } catch {
      return false;
    }
  };
  async function loadLedger(id) {
    const result = await api(
      `/api/admin/store/users/${encodeURIComponent(recipient.uid)}/wallet-ledger?limit=20${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
    );
    if (!current(id)) return;
    if (!Array.isArray(result.ledger))
      throw new Error("Bakiye defteri yanıtı doğrulanamadı.");
    cursor = result.nextCursor || "";
    ledger.innerHTML = ledgerView(result.ledger, cursor);
  }
  async function submit(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = form.querySelector("[type=submit]"),
      error = form.querySelector(".form-error");
    if (button.disabled) return;
    const id = ++requestId;
    busy(button, true);
    error.hidden = true;
    recipient = null;
    cursor = "";
    output.replaceChildren();
    ledger.innerHTML = '<p class="fine-print">Hesap doğrulanıyor…</p>';
    try {
      ensureActive();
      const result = await api(
        "/api/admin/store/wallet/recipient?identifier=" +
          encodeURIComponent(new FormData(form).get("identifier")),
      );
      if (!current(id)) return;
      const r = result.recipient;
      if (!r?.uid || !Number.isSafeInteger(r.balanceKurus))
        throw new Error("Hedef hesap doğrulanamadı.");
      recipient = r;
      output.innerHTML = `<div class="notice"><strong>${e(r.fullName || r.username || "Müşteri")}</strong><p>${e(r.username)}<br>${e(r.email)}</p><small>UID: ${e(r.uid)}</small><h3>${money(r.balanceKurus)}</h3><button type="button" class="button primary small" data-wallet-adjust-resolved>Bakiye işlemi</button></div>`;
      await loadLedger(id);
    } catch (cause) {
      if (current(id)) {
        error.hidden = false;
        error.textContent = cause.message;
        ledger.innerHTML =
          '<p class="fine-print">Hesap hareketleri doğrulanamadı. Yeniden sorgula.</p>';
      }
    } finally {
      busy(button, false);
    }
  }
  async function click(event) {
    if (event.target.closest("[data-wallet-adjust-resolved]") && recipient) {
      event.preventDefault();
      ensureActive();
      onAdjust(recipient.uid);
    }
    const button = event.target.closest("[data-wallet-next]");
    if (!button || button.disabled || !recipient) return;
    busy(button, true);
    try {
      await loadLedger(requestId);
    } catch (cause) {
      if (active) {
        const note = document.createElement("p");
        note.className = "form-error";
        note.textContent = cause.message;
        ledger.append(note);
      }
    } finally {
      busy(button, false);
    }
  }
  form.addEventListener("submit", submit);
  root.addEventListener("click", click);
  return () => {
    active = false;
    requestId++;
    form.removeEventListener("submit", submit);
    root.removeEventListener("click", click);
  };
}
