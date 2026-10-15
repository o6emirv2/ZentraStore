export function createAffiliateManager({ adminFetch, requestAdminReauth, toast, hasPermission, escapeHtml: esc, formatPrice, rememberForms, confirmDiscard } = {}) {
  const $ = selector => document.querySelector(selector);
  let links = [], cursor = '', editing = '', creationCode = '', busy = false, detailCursor = '', detailTarget = null;
  const newCode = () => 'ZA-' + [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  function reset() {
    if (busy) return;
    editing = ''; creationCode = ''; $('#affiliateForm').reset(); $('#affiliateOwner').readOnly = false;
    $('#affiliateActive').checked = true; $('#affiliateCommissionEnabled').checked = true; $('#affiliateRate').value = '30';
    $('#affiliateFormTitle').textContent = 'Yeni referans bağlantısı'; rememberForms($('#affiliateForm'));
  }
  function render() {
    $('#affiliateList').innerHTML = links.map(link => `<article class="affiliate-card"><header><div><strong>${esc(link.title)}</strong><small>${esc(link.ownerUsername)} · ${esc(link.ownerUid)}</small></div><b>%${link.rate}</b></header><p>${link.active ? 'Yeni kayıt kabul ediyor' : 'Yeni kayıtlara kapalı'} · ${link.commissionEnabled ? 'Komisyon açık' : 'Komisyon durduruldu'}</p><dl><div><dt>Kayıt</dt><dd>${link.referralCount}</dd></div><div><dt>Onaylı alışveriş</dt><dd>${link.paidOrders}</dd></div><div><dt>Kazanılan</dt><dd>${esc(formatPrice(link.earnedKurus))}</dd></div><div><dt>İncelemede</dt><dd>${esc(formatPrice(link.heldKurus || 0))}</dd></div><div><dt>İade edilen</dt><dd>${esc(formatPrice(link.reversedKurus))}</dd></div></dl><label>Paylaşım bağlantısı<input readonly value="${esc(link.url)}" /></label><div class="affiliate-card__actions"><button type="button" data-affiliate-copy="${esc(link.code)}">Kopyala</button><button type="button" data-affiliate-edit="${esc(link.code)}" ${hasPermission('store.wallet.write') ? '' : 'disabled'}>Düzenle</button><button type="button" data-affiliate-details="${esc(link.code)}" data-kind="referrals">Kayıtlar</button><button type="button" data-affiliate-details="${esc(link.code)}" data-kind="commissions">Komisyonlar</button></div></article>`).join('') || '<p class="affiliate-empty">Henüz referans bağlantısı oluşturulmadı.</p>';
    $('#affiliateMore').hidden = !cursor;
  }
  async function load(more = false) {
    if (busy) return;
    const payload = await adminFetch('/api/admin/store/affiliates' + (more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
    links = more ? [...links, ...payload.links] : payload.links; cursor = payload.nextCursor || ''; render();
  }
  async function save(event) {
    event.preventDefault();
    if (busy || !hasPermission('store.wallet.write') || !$('#affiliateForm').reportValidity()) return;
    const body = { title: $('#affiliateTitle').value.trim(), ownerUsername: $('#affiliateOwner').value.trim(), rate: Number($('#affiliateRate').value),
      active: $('#affiliateActive').checked, commissionEnabled: $('#affiliateCommissionEnabled').checked, createOnly: !editing };
    if (!creationCode) creationCode = newCode();
    const code = editing || creationCode;
    busy = true;
    $('#affiliateForm').querySelectorAll('input,select,button').forEach(node => { node.disabled = true; });
    try {
      if (!await requestAdminReauth()) return;
      const response = await adminFetch(`/api/admin/store/affiliates/${encodeURIComponent(code)}`, { method: 'PUT', body });
      editing = response.link.code; $('#affiliateOwner').readOnly = true;
      $('#affiliateFormTitle').textContent = 'Referans bağlantısını düzenle'; rememberForms($('#affiliateForm'));
      toast('success', 'Referans bağlantısı kaydedildi', 'Bağlantıyı kopyalayıp paylaşabilirsiniz.');
    } catch (error) { toast('error', 'Bağlantı kaydedilemedi', error.message); }
    finally {
      busy = false;
      $('#affiliateForm').querySelectorAll('input,select,button').forEach(node => { node.disabled = !hasPermission('store.wallet.write'); });
    }
    await load();
  }
  function edit(code) {
    const apply = () => {
      const link = links.find(row => row.code === code); if (!link) return;
      editing = code; $('#affiliateFormTitle').textContent = 'Referans bağlantısını düzenle';
      $('#affiliateTitle').value = link.title; $('#affiliateOwner').value = link.ownerUsername; $('#affiliateOwner').readOnly = true;
      $('#affiliateRate').value = String(link.rate); $('#affiliateActive').checked = link.active; $('#affiliateCommissionEnabled').checked = link.commissionEnabled;
      rememberForms($('#affiliateForm')); $('#affiliateForm').scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    confirmDiscard($('#affiliateForm'), apply) && apply();
  }
  async function details(code, kind, more = false) {
    if (!more) { detailTarget = { code, kind }; detailCursor = ''; $('#affiliateDetailRows').replaceChildren(); }
    const result = await adminFetch(`/api/admin/store/affiliates/${encodeURIComponent(code)}/details?kind=${kind}${more && detailCursor ? `&cursor=${encodeURIComponent(detailCursor)}` : ''}`);
    if (detailTarget?.code !== code || detailTarget?.kind !== kind) return;
    $('#affiliateDetails').hidden = false;
    $('#affiliateDetailTitle').textContent = `${code} · ${kind === 'referrals' ? 'Referansla kayıt olan hesaplar' : 'Alışveriş komisyonları'}`;
    const rows = result.rows.map(row => `<li><span><strong>${esc(kind === 'referrals' ? row.uid : row.orderId)}</strong><small>${esc(new Date(row.createdAt).toLocaleString('tr-TR'))} · %${row.rate}${row.reversedAt ? ' · İade / iptal ile geri alındı' : row.status === 'held' ? ' · GÜVENLİK İNCELEMESİNDE' : ''}</small></span><b>${kind === 'referrals' ? 'Kalıcı kayıt' : esc(formatPrice(row.amountKurus))}</b>${kind === 'commissions' && row.status === 'held' && !row.reversedAt && hasPermission('store.wallet.write') ? `<button type="button" data-affiliate-release="${esc(row.orderId)}">İnceleme sonrası komisyonu onayla</button>` : ''}</li>`).join('');
    if (more) $('#affiliateDetailRows').insertAdjacentHTML('beforeend', rows);
    else $('#affiliateDetailRows').innerHTML = rows || '<li>Kayıt bulunamadı.</li>';
    detailCursor = result.nextCursor || ''; $('#affiliateDetailsMore').hidden = !result.hasMore;
  }
  function action(operation) { void operation().catch(error => toast('error', 'İşlem tamamlanamadı', error.message)); }
  function bind() {
    $('#affiliateForm')?.addEventListener('submit', event => { action(() => save(event)); });
    $('#affiliateReset')?.addEventListener('click', () => { if (confirmDiscard($('#affiliateForm'), reset)) reset(); });
    $('#affiliateMore')?.addEventListener('click', () => action(() => load(true)));
    $('#affiliateDetailsMore')?.addEventListener('click', () => { if (detailTarget) action(() => details(detailTarget.code, detailTarget.kind, true)); });
    $('#affiliateDetailRows')?.addEventListener('click', event => {
      const button = event.target.closest('[data-affiliate-release]'); if (!button || busy) return;
      action(async () => {
        busy = true; button.disabled = true;
        try {
          if (!await requestAdminReauth()) return;
          await adminFetch(`/api/admin/store/affiliate-commissions/${encodeURIComponent(button.dataset.affiliateRelease)}/release`, { method: 'POST', body: {} });
          toast('success','Komisyon onaylandı','Hesap güvenliği ve sipariş durumu sunucuda yeniden doğrulandı.');
          if (detailTarget) await details(detailTarget.code, detailTarget.kind);
        } finally { busy = false; button.disabled = false; }
      });
    });
    $('#affiliateList')?.addEventListener('click', event => {
      const editButton = event.target.closest('[data-affiliate-edit]'), detailButton = event.target.closest('[data-affiliate-details]'), copyButton = event.target.closest('[data-affiliate-copy]');
      if (editButton) edit(editButton.dataset.affiliateEdit);
      if (detailButton) action(() => details(detailButton.dataset.affiliateDetails, detailButton.dataset.kind));
      if (copyButton) action(async () => { await navigator.clipboard.writeText(links.find(row => row.code === copyButton.dataset.affiliateCopy).url); toast('success', 'Bağlantı kopyalandı', 'Paylaşım bağlantısı hazır.'); });
    });
  }
  return { load, bind };
}
