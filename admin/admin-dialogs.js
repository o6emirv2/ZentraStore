import { escapeHtml } from './admin-core.js?v=zentra-ui-v90r1';

export function openAdminDialog({ title, description = '', content = '', confirmLabel = 'Onayla', collect = () => true, destructive = false }) {
  const previous = document.activeElement, dialog = document.createElement('dialog');
  const headingId = `dialog-${crypto.randomUUID()}`;
  dialog.className = 'operation-dialog';
  dialog.setAttribute('aria-labelledby', headingId);
  if (description) dialog.setAttribute('aria-describedby', `${headingId}-description`);
  dialog.innerHTML = `<form class="operation-dialog__form"><header><span class="operation-dialog__eyebrow">ZENTRA STORE</span><h2 id="${headingId}">${escapeHtml(title)}</h2>${description ? `<p id="${headingId}-description">${escapeHtml(description)}</p>` : ''}</header><div class="operation-dialog__body">${content}<p class="operation-dialog__error" role="alert" hidden></p></div><footer><button type="button" class="secondary-action" data-dialog-cancel>Vazgeç</button><button type="submit" class="${destructive ? 'danger-action' : 'primary-action'}">${escapeHtml(confirmLabel)}</button></footer></form>`;
  const overflow = document.body.style.overflow;
  document.body.append(dialog); document.body.style.overflow = 'hidden';
  const fit = () => dialog.style.setProperty('--operation-available-height', `${Math.max(180, (window.visualViewport?.height || innerHeight) - 24)}px`);
  fit(); window.visualViewport?.addEventListener('resize', fit); window.addEventListener('resize', fit);
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true; dialog.classList.add('is-closing');
      const close = () => {
        window.visualViewport?.removeEventListener('resize', fit); window.removeEventListener('resize', fit);
        dialog.close(); dialog.remove(); document.body.style.overflow = overflow;
        if (previous?.isConnected) previous.focus({ preventScroll: true });
        resolve(value);
      };
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) close(); else setTimeout(close, 120);
    };
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),a[href]')]
        .filter(node => node.getClientRects().length && (node.type !== 'radio' || node.checked || !dialog.querySelector(`input[type="radio"][name="${CSS.escape(node.name)}"]:checked`)));
      const first = focusable[0], last = focusable.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    });
    dialog.querySelector('[data-dialog-cancel]').addEventListener('click', () => finish(null));
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      try { finish(collect(dialog.querySelector('form'))); }
      catch (error) {
        const alert = dialog.querySelector('[role="alert"]'); alert.hidden = false; alert.textContent = error.message;
        error.field?.focus();
      }
    });
    dialog.showModal();
    dialog.querySelector('[autofocus],input,select,textarea,button')?.focus({ preventScroll: true });
  });
}

export function chooseOrderStatus(order, statuses) {
  const options = [...new Set([order.status, ...(order.availableTransitions || [])])].filter(key => statuses[key]);
  return openAdminDialog({ title: 'Yeni Durum', description: 'Yalnızca bu sipariş için geçerli durumlar gösterilir. Ödeme onayı ayrıca doğrulanır.', confirmLabel: 'Durumu Güncelle',
    content: `<fieldset class="status-choices"><legend>Sipariş durumu</legend>${options.map(key => `<label><input type="radio" name="status" value="${escapeHtml(key)}" ${key === order.status ? 'checked' : ''}/><span><i class="fa-solid ${escapeHtml(statuses[key].icon)}" aria-hidden="true"></i>${escapeHtml(statuses[key].label)}</span></label>`).join('')}</fieldset>`,
    collect: form => form.elements.status.value });
}

export function confirmManualPayment({ refund = false } = {}) {
  return openAdminDialog({ title: refund ? 'Manuel İade Doğrulaması' : 'Manuel Ödeme Doğrulaması',
    description: refund ? 'Harici iadenin gerçekten tamamlandığını bankanızdan veya ödeme sağlayıcınızdan doğrulayın.' : 'Telegram mesajı ödeme kanıtı değildir. Tahsilatı bankanızdan veya ödeme sağlayıcınızdan doğrulayın.',
    confirmLabel: 'Doğrulamayı Kaydet',
    content: '<label class="operation-field"><span>Banka / sağlayıcı işlem referansı</span><input name="reference" minlength="6" maxlength="160" required autocomplete="off" placeholder="İşlem / dekont referansı"/><small>Kart, hesap parolası veya tam banka bilgisi girmeyin.</small></label><label class="operation-checkbox"><input name="confirmed" type="checkbox" required/><span>İşlemin tamamlandığını harici ödeme kaydından kontrol ettim.</span></label>',
    collect: form => ({ reference: form.elements.reference.value.trim(), confirmed: form.elements.confirmed.checked }) });
}
