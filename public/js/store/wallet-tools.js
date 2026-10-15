import { storeApi, createRequestId, friendlyStoreError } from './api.js?v=zentra-security-v1';
import { reauthenticateStoreSession } from './auth.js?v=zentra-security-v1';
import { isUncertainMutationError } from '../request-utils.js?v=zentra-ui-v78';
import { formatStorePrice } from './products.js?v=zentra-ui-v78';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function parseTransferAmount(value) {
  const raw = String(value || '').trim();
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(raw)) return null;
  const [whole, cents = ''] = raw.replace(',', '.').split('.');
  const amount = Number(whole) * 100 + Number(cents.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount >= 4 && amount <= 100000000 ? amount : null;
}
export function createWalletTools({ snapshot, refresh, notify, isBusy = () => false } = {}) {
  const $ = selector => document.querySelector(selector);
  let uid = '', generation = 0, busy = false, attempt = null, historyCursor = '', affiliateLoaded = false, loading = false, loadedAt = 0;
  const pendingKey = actor => `zentra:transfer-pending:${actor}`;
  const discardPending = actor => { try { localStorage.removeItem(pendingKey(actor)); } catch (_) {} };
  const retainPending = pending => { localStorage.setItem(pendingKey(pending.uid), JSON.stringify({ uid: pending.uid, body: pending.body, quote: pending.quote, uncertain: true })); };
  const alive = (actor, version) => actor === uid && actor === String(snapshot()?.user?.uid || '') && version === generation;
  const message = text => { const host = $('#transferMessage'); if (host) host.textContent = text; };
  function lockForm(locked) { $('#walletTransferForm')?.querySelectorAll('input,button').forEach(node => { node.disabled = locked; }); }
  function resetPreview() {
    if (busy || attempt?.uncertain) return;
    attempt = null;
    if ($('#transferConfirm')) $('#transferConfirm').hidden = true;
    if ($('#transferQuote')) $('#transferQuote').hidden = true;
    message('');
  }
  function synchronize(auth) {
    const next = String(auth.user?.uid || '');
    if (next !== uid) {
      generation++; uid = next; attempt = null; historyCursor = ''; affiliateLoaded = false; loadedAt = 0; busy = false; loading = false;
      $('#walletTransferForm')?.reset(); lockForm(false);
      if ($('#transferConfirm')) $('#transferConfirm').hidden = true;
      if ($('#transferQuote')) $('#transferQuote').hidden = true;
      for (const id of ['walletHistory', 'accountAffiliateLinks']) if ($('#' + id)) $('#' + id).replaceChildren();
      message('');
      if (next) {
        try {
          const saved = JSON.parse(localStorage.getItem(pendingKey(next)) || 'null');
          if (saved?.uid === next && saved.body && /^[A-Za-z0-9_-]{16,160}$/.test(saved.body.idempotencyKey || '')
            && Number.isSafeInteger(saved.body.amountKurus) && saved.body.amountKurus >= 4 && saved.body.amountKurus <= 100000000
            && saved.body.recipientUid !== next && typeof saved.body.recipientUid === 'string' && typeof saved.body.recipientUsername === 'string') {
            attempt = { ...saved, uncertain: true };
            $('#transferRecipient').value = saved.body.recipientUsername;
            $('#transferAmount').value = (saved.body.amountKurus / 100).toFixed(2);
            $('#transferRecipient').disabled = true; $('#transferAmount').disabled = true; $('#transferPreview').disabled = true;
            $('#transferConfirm').hidden = false;
            $('#transferQuote').hidden = false;
            $('#transferQuote').textContent = `Bekleyen işlem: ${saved.body.recipientUsername} · Toplam ${formatStorePrice(saved.body.amountKurus)} · Kesinti ${formatStorePrice(saved.body.amountKurus - Math.floor(saved.body.amountKurus / 4))} · Net ${formatStorePrice(Math.floor(saved.body.amountKurus / 4))}`;
            message('Önceki transferin sonucu bekleniyor. Şifrenizi girip aynı işlemi güvenle doğrulayın.');
          }
        } catch (_) {}
      }
    }
    const debt = Number(auth.account?.affiliateDebtKurus || 0);
    if ($('#accountAffiliateDebt')) {
      $('#accountAffiliateDebt').hidden = !debt;
      $('#accountAffiliateDebt').textContent = debt ? `İade edilen komisyon borcu: ${formatStorePrice(debt)}. Gelen bakiyelerden mahsup edilir; borç kapanana kadar satın alma ve gönderim kapalıdır.` : '';
    }
  }
  async function load({ more = false, force = false } = {}) {
    if (!uid || loading || (!more && !force && Date.now() - loadedAt < 30000)) return;
    const actor = uid, version = generation; loading = true;
    const cursor = more ? historyCursor : '';
    try {
      const [history, affiliate] = await Promise.all([
        storeApi('/api/store/wallet/history' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')),
        affiliateLoaded && !force ? Promise.resolve(null) : storeApi('/api/store/affiliate')
      ]);
      if (!alive(actor, version)) return;
      const host = $('#walletHistory');
      const markup = history.entries.map(row => `<li><span><strong>${escape(row.reason)}</strong><small>${escape(new Date(row.createdAt).toLocaleString('tr-TR'))} · ${escape(row.transactionId)}</small></span><b>${row.amountKurus > 0 ? '+' : row.amountKurus < 0 ? '−' : ''}${escape(formatStorePrice(Math.abs(row.amountKurus)))}</b></li>`).join('');
      if (host) { if (more) host.insertAdjacentHTML('beforeend', markup); else host.innerHTML = markup || '<li>Henüz bakiye hareketiniz yok.</li>'; }
      historyCursor = history.nextCursor || '';
      if ($('#walletHistoryMore')) $('#walletHistoryMore').hidden = !history.hasMore;
      if (affiliate) {
        affiliateLoaded = true;
        const links = $('#accountAffiliateLinks');
        if (links) links.innerHTML = affiliate.links.length ? affiliate.links.map(link => `<article class="wallet-affiliate-link"><strong>${escape(link.title)}</strong><p>Yeni kayıtlarda %${link.rate} · ${link.referralCount} kayıt · ${link.paidOrders} alışveriş</p><p>İncelemede bekleyen: ${escape(formatStorePrice(link.heldKurus || 0))}</p><p>Net komisyon: ${escape(formatStorePrice(link.earnedKurus - link.reversedKurus))} · ${link.active ? 'Yeni kayıtlara açık' : 'Yeni kayıtlara kapalı'}${link.commissionEnabled ? '' : ' · Komisyon durduruldu'}</p><label>Referans bağlantınız<input type="text" readonly value="${escape(link.url)}" aria-label="Referans bağlantınız" /></label><button type="button" class="screen-button" data-copy-affiliate="${escape(link.url)}">Bağlantıyı kopyala</button></article>`).join('') : '<p>Hesabınıza tanımlanmış referans bağlantısı yok.</p>';
      }
      loadedAt = Date.now();
    } catch (error) {
      if (alive(actor, version) && error.code === 'AUTH_SESSION_CHANGED') {
        setTimeout(() => { if (alive(actor, version)) void load({ force: true }); }, 200);
      } else if (alive(actor, version)) notify('error', 'Bakiye bilgileri yüklenemedi', friendlyStoreError(error));
    }
    finally { if (alive(actor, version)) loading = false; }
  }
  async function preview(event) {
    event.preventDefault();
    if (busy || isBusy() || !uid || attempt?.uncertain) return;
    const form = $('#walletTransferForm'); if (!form.reportValidity()) return;
    const amountKurus = parseTransferAmount($('#transferAmount').value);
    if (amountKurus === null) { message('0,04 ₺ ile 1.000.000 ₺ arasında, en fazla iki ondalıklı bir tutar girin.'); return; }
    const actor = uid, version = generation;
    busy = true; lockForm(true);
    try {
      const result = await storeApi('/api/store/transfers/preview', { method: 'POST', body: { recipientUsername: $('#transferRecipient').value.trim(), amountKurus } });
      if (!alive(actor, version)) return;
      attempt = { uid: actor, body: { recipientUid: result.preview.recipient.uid, recipientUsername: result.preview.recipient.username,
        amountKurus, idempotencyKey: createRequestId() }, quote: result.preview, uncertain: false };
      $('#transferQuote').textContent = `${result.preview.recipient.username} hesabına: ${formatStorePrice(result.preview.netKurus)}. Bakiyenizden düşecek: ${formatStorePrice(amountKurus)}. %75 kesinti: ${formatStorePrice(result.preview.feeKurus)}. Kuruş altı fark kesintiye eklenir. Onaylanan transfer geri alınamaz.`;
      $('#transferQuote').hidden = false; $('#transferConfirm').hidden = false;
      message('Alıcıyı ve tutarları kontrol edin, ardından şifrenizle onaylayın.');
    } catch (error) { if (alive(actor, version)) message(friendlyStoreError(error)); }
    finally { if (alive(actor, version)) { busy = false; lockForm(false); } }
  }
  async function send() {
    if (busy || isBusy() || !attempt || attempt.uid !== uid) return;
    const password = $('#transferPassword').value;
    if (!password) { message('Transferi onaylamak için mevcut hesap şifrenizi girin.'); $('#transferPassword').focus(); return; }
    const actor = uid, version = generation, pending = attempt;
    busy = true; lockForm(true); let sent = false;
    try {
      await reauthenticateStoreSession(password);
      if (!alive(actor, version)) return;
      $('#transferPassword').value = '';
      try { retainPending(pending); } catch (_) { message('Güvenli tekrar kaydı oluşturulamadı. Tarayıcının site depolamasına izin verin ve yeniden deneyin.'); return; }
      sent = true;
      const result = await storeApi('/api/store/transfers', { method: 'POST', auth: 'bearer', body: pending.body, timeoutMs: 25000 });
      if (!alive(actor, version)) return;
      discardPending(actor); attempt = null; $('#walletTransferForm').reset(); $('#transferQuote').hidden = true; $('#transferConfirm').hidden = true;
      message(`Transfer tamamlandı. ${result.transfer.recipientUsername}: ${formatStorePrice(result.transfer.netKurus)} · Kesinti: ${formatStorePrice(result.transfer.feeKurus)} · İşlem: ${result.transfer.id}`);
      notify('success', 'Bakiye transfer edildi', `${result.transfer.recipientUsername} hesabına ${formatStorePrice(result.transfer.netKurus)} ulaştı.`);
      await refresh().catch(() => {}); await load({ force: true });
    } catch (error) {
      if (!alive(actor, version)) return;
      if (sent && isUncertainMutationError(error)) {
        pending.uncertain = true;
        message('İşlem yanıtı alınamadı. Aynı transferi güvenle sorgulamak/tamamlamak için şifrenizi girip yeniden onaylayın. Yeni bir transfer oluşturmayın.');
      } else {
        if (sent) { discardPending(actor); attempt = null; $('#transferQuote').hidden = true; $('#transferConfirm').hidden = true; }
        message(friendlyStoreError(error));
      }
    } finally {
      if (alive(actor, version)) {
        busy = false; lockForm(false);
        if (attempt?.uncertain) { $('#transferRecipient').disabled = true; $('#transferAmount').disabled = true; $('#transferPreview').disabled = true; }
      }
    }
  }
  function bind() {
    $('#walletTransferForm')?.addEventListener('submit', preview);
    for (const selector of ['#transferRecipient', '#transferAmount']) $(selector)?.addEventListener('input', resetPreview);
    $('#transferConfirm')?.addEventListener('click', () => { void send(); });
    $('#walletHistoryMore')?.addEventListener('click', () => { void load({ more: true }); });
    $('#walletToolsRefresh')?.addEventListener('click', () => {
      void (async () => {
        try { await refresh(); } catch (error) { notify('error', 'Bakiye yenilenemedi', friendlyStoreError(error)); }
        await load({ force: true });
      })();
    });
    $('#accountAffiliateLinks')?.addEventListener('click', async event => {
      const button = event.target.closest('[data-copy-affiliate]'); if (!button) return;
      try { await navigator.clipboard.writeText(button.dataset.copyAffiliate); notify('success', 'Bağlantı kopyalandı', 'Referans bağlantınızı paylaşabilirsiniz.'); }
      catch (_) { notify('warning', 'Bağlantıyı seçip kopyalayın', 'Bağlantı metni yukarıdaki alanda hazır.'); }
    });
  }
  return { bind, synchronize, load, get busy() { return busy; } };
}
