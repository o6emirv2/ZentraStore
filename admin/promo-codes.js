import { runAction, setFieldError, clearFieldError } from '../public/js/ui/app-ui.js?v=zentra-ui-v79-1';

export function createPromoCodeManager(ui) {
  const $ = (id) => document.getElementById(id);
  const form = $('promoCodeForm');
  const notify = (type, title, message) => ui.toast(type, title, message, { operation: 'BAKİYE' });
  let codes = [], editingCode = '', busy = false;
  const fields = ['promoCode', 'promoTitle', 'promoAmount', 'promoLimit', 'promoStarts', 'promoEnds', 'promoActive'];
  const fail = (id, message) => { setFieldError($(id), message); $(id).focus(); };
  const dateInput = (time) => time ? new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';

  function render() {
    const labels = { available: 'Aktif', expired: 'Süresi doldu', scheduled: 'Henüz başlamadı', exhausted: 'Kullanım hakkı doldu', inactive: 'Pasif' };
    $('promoCodeList').innerHTML = codes.length ? codes.map((row) => `<div class="promotion-admin-item"><span><strong>${ui.escapeHtml(row.code)} · ${ui.escapeHtml(ui.formatPrice(row.value))}</strong><small>${ui.escapeHtml(row.title)} · ${row.usedCount}/${row.usageLimit} kullanım · ${ui.escapeHtml(labels[row.status] || 'Kontrol ediliyor')}</small></span><button class="secondary-action" type="button" data-edit-promo-code="${ui.escapeHtml(row.code)}">Düzenle</button></div>`).join('') : ui.emptyMarkup('Promosyon kodu bulunmuyor', 'Yeni bir kod oluşturduğunuzda burada görünecek.', 'fa-gift');
    ui.renderLiveStatus('#promoCodeMetrics', { icon: 'fa-wallet', title: `${codes.filter((row) => row.status === 'available').length} aktif promosyon kodu`, detail: `${codes.length} yüklenen kayıt · En fazla 100 kayıt gösterilir · Her hesap aynı koddan bir kez yararlanır`, tone: 'ok', meta: 'BAKİYE PROMOSYONU' });
  }

  async function load() {
    const allowed = ui.hasPermission('store.wallet.write');
    form.hidden = !allowed;
    if (!allowed) {
      $('promoCodeList').innerHTML = ui.emptyMarkup('Mali yetki gerekli', 'Promosyon kodu oluşturma ve kayıtları görme yetkisi bu role atanmadı.', 'fa-lock');
      ui.renderLiveStatus('#promoCodeMetrics', { icon: 'fa-lock', title: 'Promosyon kodları', detail: 'Bu bölüm doğrudan bakiye ekler. İşlemler mali yetkiyle korunur.', tone: 'warn', meta: 'YETKİ GEREKLİ' });
      return;
    }
    $('promoCodeList').innerHTML = ui.loadingMarkup('Promosyon kodları yükleniyor');
    try {
      const response = await ui.adminFetch('/api/admin/store/balance-codes');
      codes = Array.isArray(response.codes) ? response.codes.filter((row) => row.type === 'balance') : [];
      render();
    } catch (error) {
      $('promoCodeList').innerHTML = ui.failureMarkup('Promosyon kodları yüklenemedi', error, 'promocodes');
      throw error;
    }
  }

  async function reset(force = false) {
    if (busy || (!force && !ui.confirmDiscard(form, () => { void reset(true); }))) return;
    editingCode = '';
    form.reset();
    $('promoEditStatus').textContent = '';
    $('promoCode').readOnly = false;
    $('promoAmount').readOnly = false;
    $('generatePromoCode').disabled = false;
    fields.forEach((id) => clearFieldError($(id)));
    ui.rememberForms(form);
    $('promoCode').focus();
  }

  async function edit(code, force = false) {
    const row = codes.find((item) => item.code === code);
    if (busy || !row || (!force && !ui.confirmDiscard(form, () => { void edit(code, true); }))) return;
    editingCode = row.code;
    fields.forEach((id) => clearFieldError($(id)));
    $('promoCode').value = row.code; $('promoCode').readOnly = true;
    $('generatePromoCode').disabled = true;
    $('promoTitle').value = row.title;
    $('promoAmount').value = row.value / 100; $('promoAmount').readOnly = row.usedCount > 0;
    $('promoLimit').value = row.usageLimit;
    $('promoStarts').value = dateInput(row.startsAt); $('promoEnds').value = dateInput(row.endsAt);
    $('promoActive').checked = row.active;
    $('promoEditStatus').textContent = row.usedCount > 0 ? `${row.usedCount} kez kullanıldı. Kullanılmış kodun tutarı değiştirilemez.` : 'Kayıtlı promosyon kodunu düzenliyorsunuz.';
    ui.rememberForms(form);
    form.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    $('promoTitle').focus({ preventScroll: true });
  }

  async function save() {
    if (busy || !ui.requirePermission('store.wallet.write', 'Promosyon kodu kaydetme')) return;
    fields.forEach((id) => clearFieldError($(id)));
    const code = $('promoCode').value.trim().toUpperCase();
    const title = $('promoTitle').value.trim();
    const amount = ui.parseMoneyInput($('promoAmount').value);
    const usageLimit = Number($('promoLimit').value);
    if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) return fail('promoCode', 'Kod 3-32 karakter olmalı; harf, sayı, tire veya alt çizgi kullanın.');
    if (!title || title.length > 100) return fail('promoTitle', 'Promosyon adını girin; en fazla 100 karakter kullanın.');
    if (!Number.isFinite(amount) || amount < 0.01 || amount > 1000000) return fail('promoAmount', 'Eklenecek bakiye 0,01 ile 1.000.000 ₺ arasında olmalıdır.');
    if (!Number.isSafeInteger(usageLimit) || usageLimit < 1 || usageLimit > 1000000) return fail('promoLimit', 'Toplam kullanım limiti 1 ile 1.000.000 arasında olmalıdır.');
    const startsAt = $('promoStarts').value ? Date.parse($('promoStarts').value) : 0;
    const endsAt = $('promoEnds').value ? Date.parse($('promoEnds').value) : 0;
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || (startsAt && endsAt && endsAt <= startsAt)) return fail('promoEnds', 'Bitiş tarihi başlangıç tarihinden sonra olmalıdır.');
    const body = { title, value: Math.round(amount * 100), usageLimit, perUserLimit: 1, startsAt, endsAt, active: $('promoActive').checked, createOnly: !editingCode };
    busy = true;
    const controls = [...form.querySelectorAll('input,button')];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    try {
      if (!await ui.requestAdminReauth()) return;
      await ui.adminFetch(`/api/admin/store/balance-codes/${encodeURIComponent(code)}`, { method: 'PUT', timeoutMs: 30000, body });
      editingCode = code; $('promoCode').readOnly = true;
      $('promoEditStatus').textContent = 'Promosyon kodu kaydedildi.';
      ui.rememberForms(form);
      notify('success', 'Promosyon kodu kaydedildi', `${code} kullanıldığında ${ui.formatPrice(body.value)} hesaba eklenir.`);
      try { await load(); } catch (_) { notify('warning', 'Kod kaydedildi', 'Liste yenilenemedi. Kayıt başarılı; listeyi yeniden yükleyin.'); }
    } catch (error) {
      const field = /CODE_EXISTS|CODE_INVALID|STORE_PROMOTION_TYPE_LOCKED/.test(error.code) ? 'promoCode' : /DATE/.test(error.code) ? 'promoEnds' : /LIMIT|CONFIGURATION/.test(error.code) ? 'promoLimit' : /VALUE|BALANCE_CODE_INPUT_INVALID/.test(error.code) ? 'promoAmount' : '';
      if (field) setFieldError($(field), error.message);
      notify('error', 'Promosyon kaydedilemedi', error.message);
    } finally {
      busy = false;
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      $('generatePromoCode').disabled = !!editingCode;
    }
  }

  function bind() {
    form.addEventListener('submit', (event) => { event.preventDefault(); void runAction(form.querySelector('[type=submit]'), save, 'Promosyon kaydediliyor…').catch((error) => notify('error', 'Promosyon kaydedilemedi', error.message)); });
    $('newPromoCode').addEventListener('click', () => { void reset().catch((error) => notify('error', 'Form açılamadı', error.message)); });
    $('generatePromoCode').addEventListener('click', () => {
      if (busy || editingCode || !ui.requirePermission('store.wallet.write', 'Promosyon kodu oluşturma')) return;
      if (!window.crypto?.getRandomValues) return notify('error', 'Kod oluşturulamadı', 'Güvenli kod üreticisi kullanılamıyor.');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      $('promoCode').value = `ZENTRA-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (value) => alphabet[value % 32]).join('')}`;
      $('promoTitle').focus();
    });
    $('promoCodeList').addEventListener('click', (event) => { const button = event.target.closest('[data-edit-promo-code]'); if (button) void edit(button.dataset.editPromoCode).catch((error) => notify('error', 'Promosyon açılamadı', error.message)); });
  }

  return { bind, load };
}
