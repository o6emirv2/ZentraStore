export function createAccountSecurityManager({ adminFetch, requestAdminReauth, toast, hasPermission, escapeHtml: esc, formatPrice } = {}) {
  const $ = selector => document.querySelector(selector);
  let cursor = '', selected = null, busy = false, sequence = 0, eventLoading = false;
  const matchLabels = { 'registration-ip':'Kayıt/gözlem IP eşleşmesi', 'observed-ip':'Son kullanılan IP eşleşmesi',
    'registration-device':'Kaydedilmiş cihaz eşleşmesi', 'observed-device':'Son kullanılan cihaz eşleşmesi' };
  const codes = { SECURITY_IP_ACCOUNT_EXISTS:'Aynı IP ile ikinci kayıt', SECURITY_DEVICE_ACCOUNT_EXISTS:'Aynı cihazla ikinci kayıt',
    SECURITY_NETWORK_BLOCKED:'VPN / proxy / hosting engeli', SECURITY_IP_BLOCKED:'Yasaklı IP', SECURITY_DEVICE_BLOCKED:'Yasaklı cihaz',
    SECURITY_ACCOUNT_BLOCKED:'Askıya alınan hesap', SECURITY_REGISTRATION_REQUIRED:'Tamamlanmamış kayıt', OBSERVED_SHARED_DEVICE:'Başka hesapta gözlenen cihaz',
    SECURITY_NETWORK_UNCONFIGURED:'VPN veri dosyası yapılandırılmamış', SECURITY_NETWORK_DB_STALE:'VPN verisi güncel değil', SECURITY_PROXY_UNCONFIGURED:'Güvenilir proxy ağı yapılandırılmamış' };
  function eventMarkup(row) {
    return `<li><span><strong>${esc(codes[row.code] || row.code)}</strong><small>${esc(row.ipMask || 'IP bilinmiyor')} · ${esc(row.uid || 'Kayıt öncesi')} · ${esc(new Date(row.createdAt).toLocaleString('tr-TR'))} · ${row.hits || 1} deneme${row.relatedUid ? ` · İlişkili: ${esc(row.relatedUid)}` : ''}</small></span>${row.uid ? `<button class="secondary-action" type="button" data-abuse-inspect="${esc(row.uid)}">İncele</button>` : ''}</li>`;
  }
  async function load(more = false) {
    if (eventLoading) return;
    eventLoading = true;
    try {
      const data = await adminFetch('/api/admin/store/abuse' + (more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
      const status = $('#abuseReadiness');
      status.textContent = data.readiness.ready ? 'Sıkı koruma açık · Güncel VPN/proxy verisi hazır · IP veya cihaz eşleşmesinde ikinci kayıt reddedilir.'
        : `Standart hesaplarda kayıt ve yeni mali işlemler güvenlik nedeniyle kapalı: ${codes[data.readiness.reason] || data.readiness.reason}. Hesap girişi korunur. Kurulum dosyasındaki ayarları tamamlayın. Doğrulanmış yönetici istisnası devam eder.`;
      status.classList.toggle('is-ready', data.readiness.ready);
      if (more) $('#abuseEvents').insertAdjacentHTML('beforeend', data.events.map(eventMarkup).join(''));
      else $('#abuseEvents').innerHTML = data.events.map(eventMarkup).join('') || '<li>Henüz güvenlik olayı yok.</li>';
      cursor = data.nextCursor || ''; $('#abuseMore').hidden = !data.hasMore;
    } finally { eventLoading = false; }
  }
  async function inspect(uid) {
    const current = ++sequence;
    const response = await adminFetch(`/api/admin/store/abuse/users/${encodeURIComponent(uid)}`);
    if (current !== sequence) return;
    selected = response.account;
    const a = selected, reg = a.registration, seen = a.observed;
    $('#abuseAccount').hidden = false;
    const admission = a.networkExempt ? 'Doğrulanmış mağaza yöneticisi · IP / cihaz / VPN istisnası'
      : reg?.kind === 'registration' ? 'Koruma altında kaydedilmiş hesap'
      : reg?.kind === 'legacy_observation' ? 'Eski hesap / sonradan gözlenen ilişki; geçmiş kayıt IP’si bilinmiyor' : 'Hesap kaydının güvenlik onayı henüz tamamlanmamış';
    $('#abuseAccountInfo').innerHTML = `<h2>${esc(a.username)} · ${a.state === 'blocked' ? 'ASKIYA ALINDI' : 'AKTİF'}</h2><p>UID: ${esc(a.uid)} · Bakiye: ${esc(formatPrice(a.balanceKurus))}</p><p>${admission}</p><p>Kayıt/gözlem IP’si: ${esc(reg?.ipMask || seen?.ipMask || 'Bilinmiyor')} · Cihaz: ${esc(a.identifiers.deviceId.slice(0, 16) || 'Bilinmiyor')}</p>${seen ? `<p>Son kullanılan IP: ${esc(seen.ipMask || 'Bilinmiyor')} · Cihaz: ${esc(seen.deviceId?.slice(0, 16) || 'Bilinmiyor')} · ${esc(new Date(seen.at).toLocaleString('tr-TR'))}</p>` : ''}<p>IP sahibi: ${esc(a.identifiers.ipOwner || 'Bağlanmamış')} · Cihaz sahibi: ${esc(a.identifiers.deviceOwner || 'Bağlanmamış')}</p><p>IP yasağı: ${a.identifiers.ipBlocked ? 'Var' : 'Yok'} · Cihaz yasağı: ${a.identifiers.deviceBlocked ? 'Var' : 'Yok'}${a.referral ? ` · Referans: ${esc(a.referral.code)}` : ''}</p><p>Son gerekçe: ${esc(a.reason || 'Yok')}${a.revocationPending ? ' · Kimlik sağlayıcısındaki oturum iptali yeniden denenmeli; sunucu engeli aktiftir.' : ''}${a.restorationPending ? ' · Hesabın yeniden açılması tamamlanamadı. Hesap güvenlik nedeniyle askıda kaldı; yeniden açma işlemini tekrar deneyin.' : ''}</p>`;
    $('#abuseRelated').innerHTML = a.relatedAccounts?.length ? a.relatedAccounts.map(row => `<li><span><strong>${esc(row.username)} · ${esc(row.uid)}</strong><small>${esc(row.matches.map(value => matchLabels[value] || value).join(', '))} · ${row.state === 'blocked' ? 'Askıda' : 'Aktif'}</small></span><button class="secondary-action" type="button" data-abuse-inspect="${esc(row.uid)}">İncele</button></li>`).join('') : '<li>Kaydedilmiş ortak IP/cihaz ilişkisi yok.</li>';
    $('#abuseAccountEvents').innerHTML = a.events.map(eventMarkup).join('') || '<li>Bu hesap için olay kaydı yok.</li>';
    $('#abuseAccountMoney').innerHTML = a.recentMoney.map(row => `<li><span><strong>${esc(row.type)} · ${esc(row.reason)}</strong><small>${esc(row.orderId)}</small></span><b>${esc(formatPrice(row.amountKurus, true))}</b></li>`).join('') || '<li>Bakiye hareketi yok.</li>';
    $('#abuseReason').value = '';
    for (const action of ['suspend','restore','retry-revocation']) {
      const button = $(`[data-abuse-action="${action}"]`);
      button.disabled = !hasPermission('store.users.write');
      button.hidden = a.networkExempt || (action === 'suspend' ? a.state === 'blocked' : action === 'restore' ? a.state !== 'blocked' : !a.revocationPending);
    }
  }
  async function search(event) {
    event.preventDefault(); if (busy) return;
    const identifier = $('#abuseSearch').value.trim(); if (!identifier) return;
    const result = await adminFetch('/api/admin/store/users/resolve?identifier=' + encodeURIComponent(identifier));
    await inspect(result.user.uid);
  }
  async function moderate(action) {
    if (busy || !selected || !hasPermission('store.users.write')) return;
    const reason = $('#abuseReason').value.trim();
    if (reason.length < 8) { toast('warning','Gerekçe gerekli','En az 8 karakterlik bir inceleme gerekçesi yazın.'); return; }
    const uid = selected.uid, revision = selected.revision;
    busy = true;
    $('#abuseAccount').querySelectorAll('button,textarea').forEach(node => { node.disabled = true; });
    try {
      if (!await requestAdminReauth()) return;
      const result = await adminFetch(`/api/admin/store/abuse/users/${encodeURIComponent(uid)}`, { method:'PUT', body:{action,reason,revision} });
      const pending = result.result.revocationPending || result.result.restorationPending;
      toast(pending ? 'warning' : 'success', 'Güvenlik kararı kaydedildi', result.result.restorationPending ? 'Hesap askıda kaldı. Yeniden açmayı tekrar deneyin.' : result.result.revocationPending ? 'Sunucu engeli aktif. Oturum iptalini yeniden deneyin.' : 'Hesap ve kendisine ait IP/cihaz yasağı güncellendi.');
      await inspect(uid); await load();
    } finally {
      busy = false;
      $('#abuseAccount').querySelectorAll('button,textarea').forEach(node => { node.disabled = !hasPermission('store.users.write'); });
    }
  }
  const run = action => { void action().catch(error => toast('error','Güvenlik işlemi tamamlanamadı',error.message)); };
  function bind() {
    $('#abuseSearchForm')?.addEventListener('submit', event => run(() => search(event)));
    $('#abuseMore')?.addEventListener('click', () => run(() => load(true)));
    $('#abuseRefresh')?.addEventListener('click', () => run(() => load()));
    $('[data-admin-panel="abuse"]')?.addEventListener('click', event => {
      const inspectButton = event.target.closest('[data-abuse-inspect]'), action = event.target.closest('[data-abuse-action]');
      if (inspectButton && !busy) run(() => inspect(inspectButton.dataset.abuseInspect));
      if (action) run(() => moderate(action.dataset.abuseAction));
    });
  }
  return { bind, load };
}
