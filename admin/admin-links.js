import { escapeHtml } from './admin-core.js?v=zentra-ui-v90r1';
import { openAdminDialog } from './admin-dialogs.js?v=zentra-ui-v90r1';
import { LINK_PLATFORM_META, MAX_QUICK_LINKS, validateQuickLink } from '../public/js/store/social-links.js?v=zentra-ui-v90r1';

export function createLinkManager({ host, statusHost, addButton, request, authorize, canWrite, toast, onSaved = () => {} }) {
  let links = [], revision = 0, busy = false;
  function render() {
    addButton.disabled = busy || !canWrite() || links.length >= MAX_QUICK_LINKS;
    const active = links.filter(link => link.enabled && link.showOnHome !== false).length;
    statusHost.textContent = `${active} bağlantı yayında · ${links.length}/${MAX_QUICK_LINKS} kayıt`;
    host.innerHTML = links.length ? links.map((link, index) => `<article class="managed-link" data-managed-link="${escapeHtml(link.id)}"><header><span class="managed-link__icon"><i class="fa-brands ${escapeHtml(LINK_PLATFORM_META[link.platform]?.icon || 'fa-telegram')}" aria-hidden="true"></i></span><div><h3>${escapeHtml(link.title)}</h3><span>${escapeHtml(LINK_PLATFORM_META[link.platform]?.label || link.platform)} · Sıra ${index + 1}</span></div><b class="managed-link__state ${link.enabled ? 'is-active' : ''}">${link.enabled ? 'Aktif' : 'Pasif'}</b></header><p>${escapeHtml(link.description)}</p><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(link.url)}">${escapeHtml(link.url)}</a><div class="managed-link__publication">Ana sayfada göster: <strong>${link.showOnHome !== false ? 'Açık' : 'Kapalı'}</strong></div><footer><button type="button" data-link-action="edit">Düzenle</button><button type="button" data-link-action="toggle">${link.enabled ? 'Pasif Yap' : 'Aktif Yap'}</button><button type="button" data-link-action="up" aria-label="${escapeHtml(link.title)} yukarı taşı" ${index === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button><button type="button" data-link-action="down" aria-label="${escapeHtml(link.title)} aşağı taşı" ${index === links.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button><button type="button" data-link-action="delete" class="is-danger">Sil</button></footer></article>`).join('') : '<p class="operation-empty">Kayıtlı bağlantı yok. Bağlantı Ekle ile başlayın.</p>';
    host.querySelectorAll('button').forEach(button => { if (busy || !canWrite()) button.disabled = true; });
  }
  async function load() {
    const result = await request('/api/admin/store/links');
    links = result.links || []; revision = result.revision || 0; render();
    return links;
  }
  async function persist(next) {
    if (busy || !canWrite()) return false;
    if (!(await authorize())) return false;
    busy = true; render();
    try {
      const response = await request('/api/admin/store/links', { method: 'PUT', timeoutMs: 30_000, body: { links: next, expectedRevision: revision } });
      links = response.links; revision = response.revision;
      // The GET validates persistence and displays the authoritative saved values.
      await load(); onSaved();
      try { const channel = new BroadcastChannel('zentra-catalog'); channel.postMessage({ type: 'links-updated' }); channel.close(); } catch (_) {}
      toast('success', 'Bağlantılar kaydedildi', 'Kaydedilen veriler sunucudan yeniden okundu.'); return true;
    } catch (error) {
      toast('error', 'Bağlantı işlemi doğrulanamadı', error.message);
      if (error.code === 'STORE_LINK_REVISION_CONFLICT') { await load().catch(() => {}); return null; }
      return false;
    }
    finally { busy = false; render(); }
  }
  async function edit(index = -1, draft) {
    if (busy || !canWrite()) return;
    const original = draft || links[index] || { id: `link-${crypto.randomUUID()}`, platform: 'telegram', title: '', description: '', url: '', enabled: true, showOnHome: true };
    const result = await openAdminDialog({ title: index < 0 ? 'Bağlantı Ekle' : 'Bağlantıyı Düzenle', confirmLabel: 'Kaydet',
      content: `<div class="operation-fields"><label class="operation-field"><span>Platform</span><select name="platform">${Object.entries(LINK_PLATFORM_META).map(([key, meta]) => `<option value="${key}" ${key === original.platform ? 'selected' : ''}>${escapeHtml(meta.label)}</option>`).join('')}</select></label><label class="operation-field"><span>Bağlantı Başlığı</span><input name="title" value="${escapeHtml(original.title)}" required maxlength="48"/></label><label class="operation-field operation-field--wide"><span>Alt Açıklama</span><input name="description" value="${escapeHtml(original.description)}" required maxlength="80"/></label><label class="operation-field operation-field--wide"><span>Bağlantı URL Adresi</span><input name="url" type="url" value="${escapeHtml(original.url)}" required maxlength="500" inputmode="url" spellcheck="false" placeholder="https://t.me/hesap"/></label><label class="operation-field"><span>Sıralama</span><input name="position" type="number" min="1" max="${links.length + (index < 0 ? 1 : 0)}" value="${index < 0 ? links.length + 1 : index + 1}" required/></label><div class="operation-switches"><label class="operation-checkbox"><input name="enabled" type="checkbox" ${original.enabled ? 'checked' : ''}/><span>Aktif</span></label><label class="operation-checkbox"><input name="showOnHome" type="checkbox" ${original.showOnHome !== false ? 'checked' : ''}/><span>Ana Sayfada Göster</span></label></div></div>`,
      collect: form => {
        let value;
        try { value = validateQuickLink({ ...original, platform: form.elements.platform.value, title: form.elements.title.value,
          description: form.elements.description.value, url: form.elements.url.value, enabled: form.elements.enabled.checked, showOnHome: form.elements.showOnHome.checked }); }
        catch (error) { throw new Error(({ STORE_LINK_URL_INVALID: 'Bağlantı adresi seçilen platformun resmî HTTPS alan adıyla eşleşmelidir.', STORE_LINK_LABEL_REQUIRED: 'Başlık ve alt açıklamayı doldurun.', STORE_LINK_PLATFORM_INVALID: 'Geçerli bir platform seçin.' })[error.code] || 'Bağlantı bilgilerini kontrol edin.'); }
        if (links.some((link, i) => i !== index && (link.id === value.id || link.url.toLowerCase() === value.url.toLowerCase()))) throw new Error('Bu bağlantı zaten kayıtlı.');
        return { value, position: Number(form.elements.position.value) - 1 };
      } });
    if (!result) return;
    const next = links.filter((_, i) => i !== index); next.splice(result.position, 0, result.value);
    const saved = await persist(next);
    if (saved === false) await edit(index, result.value);
  }
  host.addEventListener('click', async event => {
    const button = event.target.closest('[data-link-action]'), card = button?.closest('[data-managed-link]');
    if (!card || busy || !canWrite()) return;
    const index = links.findIndex(link => link.id === card.dataset.managedLink), action = button.dataset.linkAction;
    if (index < 0) return;
    if (action === 'edit') return void edit(index);
    const next = links.map(link => ({ ...link }));
    if (action === 'delete') {
      const confirmed = await openAdminDialog({ title: 'Bağlantıyı Sil', description: `${links[index].title} kaydı bağlantı listesinden kaldırılacak.`, confirmLabel: 'Sil', destructive: true });
      if (!confirmed) return; next.splice(index, 1);
    } else if (action === 'toggle') next[index].enabled = !next[index].enabled;
    else {
      const target = index + (action === 'up' ? -1 : 1);
      if (target < 0 || target >= next.length) return;
      [next[index], next[target]] = [next[target], next[index]];
    }
    await persist(next);
  });
  addButton.addEventListener('click', () => { if (links.length < MAX_QUICK_LINKS) void edit(); });
  return { load, render };
}
