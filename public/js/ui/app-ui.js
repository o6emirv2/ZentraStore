const actions = new WeakMap();
const regions = new WeakMap();
const scrollPositions = new WeakMap();
const formBaselines = new WeakMap();
const fieldErrors = new WeakMap();
let fieldErrorSequence = 0;
const focusableSelector = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function spinnerMarkup(size = 'small') {
  const safeSize = ['small', 'medium', 'large'].includes(size) ? size : 'small';
  return `<span class="activity-indicator activity-indicator--${safeSize}" aria-hidden="true">${Array.from({ length: 12 }, (_, i) => `<span style="--spoke:${i}"></span>`).join('')}</span>`;
}

export function skeletonMarkup({ count = 3, label = 'Bilgiler yükleniyor', variant = 'rows' } = {}) {
  const safeLabel = String(label).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const safeVariant = ['product', 'summary', 'rows'].includes(variant) ? variant : 'rows';
  const action = safeVariant === 'product' ? '<span class="app-skeleton-line app-skeleton-action"></span>' : '';
  return `<div class="app-skeleton-group app-skeleton-group--${safeVariant}" role="status" aria-label="${safeLabel}"><span class="sr-only">${safeLabel}</span>${Array.from({ length: Math.max(1, Math.min(6, count)) }, () => `<div class="app-skeleton-card" aria-hidden="true"><span class="app-skeleton-media"></span><span class="app-skeleton-line"></span><span class="app-skeleton-line app-skeleton-line--short"></span>${action}</div>`).join('')}</div>`;
}

export function setActionBusy(button, busy, label = 'İşlem yapılıyor…') {
  if (!button) return;
  if (busy) {
    if (actions.has(button)) return;
    const rect = button.getBoundingClientRect();
    actions.set(button, { html: button.innerHTML, disabled: button.disabled, minWidth: button.style.minWidth, width: button.style.width });
    button.style.minWidth = `${Math.ceil(rect.width)}px`;
    button.style.width = `${Math.ceil(rect.width)}px`;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('is-action-busy');
    button.innerHTML = spinnerMarkup();
    const text = document.createElement('span');
    text.textContent = label;
    button.append(text);
  } else {
    const old = actions.get(button);
    if (!old) return;
    button.innerHTML = old.html;
    button.disabled = old.disabled;
    button.style.minWidth = old.minWidth;
    button.style.width = old.width;
    button.removeAttribute('aria-busy');
    button.classList.remove('is-action-busy');
    actions.delete(button);
  }
}

export async function runAction(button, operation, label) {
  if (button && actions.has(button)) return;
  setActionBusy(button, true, label);
  try { return await operation(); }
  finally { setActionBusy(button, false); }
}

export function beginRegion(host, label = 'Bilgiler yükleniyor…', { delay = 180 } = {}) {
  if (!host) return () => {};
  regions.get(host)?.();
  const status = document.createElement('div');
  status.className = 'app-region-status';
  status.setAttribute('role', 'status');
  status.innerHTML = spinnerMarkup('medium');
  const text = document.createElement('span');
  text.textContent = label;
  status.append(text);
  host.setAttribute('aria-busy', 'true');
  const timer = window.setTimeout(() => {
    if (host.isConnected) host.prepend(status);
  }, delay);
  const finish = () => {
    window.clearTimeout(timer);
    status.remove();
    if (regions.get(host) === finish) {
      host.removeAttribute('aria-busy');
      regions.delete(host);
    }
  };
  regions.set(host, finish);
  return finish;
}

export function animateView(panel) {
  if (!panel || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  panel.getAnimations?.().filter((a) => a.id === 'zentra-view').forEach((a) => a.cancel());
  const animation = panel.animate?.([{ opacity: .35, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });
  if (animation) animation.id = 'zentra-view';
}

export function restoreViewScroll(container, from, to) {
  if (!container) return;
  const positions = scrollPositions.get(container) || new Map();
  if (from) positions.set(from, container.scrollTop);
  scrollPositions.set(container, positions);
  container.scrollTo({ top: positions.get(to) || 0, behavior: 'auto' });
}

function formSignature(form) {
  const text = [...form.elements].filter((el) => el.matches('input,textarea,select')).map((el) => `${el.name || el.id}:${el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value}`).join('\u001f');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function rememberForms(container) {
  container?.querySelectorAll('form').forEach((form) => formBaselines.set(form, formSignature(form)));
  if (container?.matches('form')) formBaselines.set(container, formSignature(container));
}

export function hasUnsavedForms(container) {
  const forms = [...(container?.querySelectorAll('form') || [])];
  if (container?.matches('form')) forms.push(container);
  return forms.some((form) => formBaselines.has(form) && formBaselines.get(form) !== formSignature(form));
}

export function setFieldError(field, message) {
  if (!field) return;
  let node = fieldErrors.get(field);
  if (!node) {
    node = document.createElement('small');
    node.id = `zentra-field-error-${++fieldErrorSequence}`;
    node.className = 'app-field-error';
    const wrapper = field.closest('.form-field__input');
    (wrapper || field).insertAdjacentElement('afterend', node);
    fieldErrors.set(field, node);
  }
  node.textContent = message;
  field.setAttribute('aria-invalid', 'true');
  const ids = new Set((field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  ids.add(node.id);
  field.setAttribute('aria-describedby', [...ids].join(' '));
}

export function clearFieldError(field) {
  const node = fieldErrors.get(field);
  if (node) {
    const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== node.id);
    if (ids.length) field.setAttribute('aria-describedby', ids.join(' '));
    else field.removeAttribute('aria-describedby');
    node.remove();
    fieldErrors.delete(field);
  }
  field.removeAttribute('aria-invalid');
}

export function confirmDiscard(container, onDiscard) {
  if (!hasUnsavedForms(container)) return true;
  if (document.getElementById('appDiscardDialog')) return false;
  const layer = document.createElement('div');
  layer.id = 'appDiscardDialog';
  layer.className = 'reauth-layer app-confirm-layer';
  layer.innerHTML = '<div class="reauth-backdrop"></div><section class="reauth-card" role="dialog" aria-modal="true" aria-labelledby="appDiscardTitle" tabindex="-1"><h2 id="appDiscardTitle">Değişiklikler kaydedilmedi</h2><p>Bu ekranı kapatırsanız kaydedilmemiş değişiklikleriniz silinecek.</p><div class="reauth-actions"><button type="button" data-discard-cancel>Düzenlemeye devam et</button><button type="button" data-discard-confirm>Değişiklikleri bırak</button></div></section>';
  const cancel = () => layer.remove();
  layer.querySelector('[data-discard-cancel]').addEventListener('click', cancel);
  layer.querySelector('[data-discard-confirm]').addEventListener('click', () => { layer.remove(); rememberForms(container); onDiscard(); });
  layer.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } });
  document.body.append(layer);
  layer.querySelector('[data-discard-cancel]').focus();
  return false;
}

export function confirmOperation({ title, message, confirmLabel = 'Onayla', onConfirm } = {}) {
  if (document.getElementById('appConfirmDialog')) return;
  const layer = document.createElement('div');
  layer.id = 'appConfirmDialog';
  layer.className = 'reauth-layer app-confirm-layer';
  layer.innerHTML = '<div class="reauth-backdrop"></div><section class="reauth-card" role="dialog" aria-modal="true" aria-labelledby="appConfirmTitle"><h2 id="appConfirmTitle"></h2><p data-confirm-message></p><div class="reauth-actions"><button type="button" data-confirm-cancel>Vazgeç</button><button type="button" data-confirm-accept></button></div></section>';
  layer.querySelector('h2').textContent = title;
  layer.querySelector('[data-confirm-message]').textContent = message;
  const cancel = layer.querySelector('[data-confirm-cancel]');
  const accept = layer.querySelector('[data-confirm-accept]');
  accept.textContent = confirmLabel;
  cancel.addEventListener('click', () => { if (!accept.disabled) layer.remove(); });
  accept.addEventListener('click', () => {
    void runAction(accept, async () => {
      const result = await onConfirm();
      if (result !== false) layer.remove();
    }, 'İşlem doğrulanıyor…').catch(() => { layer.querySelector('[data-confirm-message]').textContent = 'Yanıt doğrulanamadı. Durumu kontrol ederek yeniden deneyin.'; });
  });
  layer.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!accept.disabled) layer.remove(); } });
  document.body.append(layer);
  cancel.focus();
}

function visibleDialogs() {
  return [...document.querySelectorAll('[role="dialog"]')].filter((el) => !el.closest('[hidden],[inert]:not([data-app-inert]),[aria-hidden="true"]') && el.getClientRects().length);
}

export function installAppUI() {
  if (window.__ZENTRA_APP_UI__) return;
  window.__ZENTRA_APP_UI__ = true;
  const syncVisibility = () => document.documentElement.toggleAttribute('data-app-hidden', document.hidden);
  document.addEventListener('visibilitychange', syncVisibility);
  syncVisibility();
  const originals = new WeakMap();
  const openedAt = new WeakMap();
  const returnTargets = new WeakMap();
  const dialogFocus = new WeakMap();
  let dialogSequence = 0;
  let activeDialog = null;
  const reserveNoticeSpace = () => {
    let chromeBottom = document.querySelector('.admin-topbar,.topbar')?.getBoundingClientRect().bottom || 76;
    const sidebar = document.querySelector('.admin-sidebar');
    if (sidebar && getComputedStyle(sidebar).position !== 'fixed') chromeBottom = Math.max(chromeBottom, sidebar.getBoundingClientRect().bottom);
    document.documentElement.style.setProperty('--app-notice-offset', `${activeDialog ? 0 : Math.max(76, Math.ceil(chromeBottom))}px`);
    let bottom = 0;
    let height = 0;
    document.querySelectorAll('.notification-center').forEach((host) => {
      if (!host.querySelector('.zentra-notice')) return;
      const rect = host.getBoundingClientRect();
      bottom = Math.max(bottom, rect.bottom);
      height = Math.max(height, rect.height);
    });
    const space = activeDialog && bottom ? Math.ceil(bottom + 12) : 0;
    document.documentElement.style.setProperty('--app-notice-reserve', `${space}px`);
    document.documentElement.style.setProperty('--app-page-notice-space', `${height ? Math.ceil(height + 24) : 0}px`);
    document.documentElement.toggleAttribute('data-app-notice-reserved', space > 0);
  };
  const synchronize = () => {
    const dialogs = visibleDialogs().sort((a, b) => (openedAt.get(a) || 0) - (openedAt.get(b) || 0));
    const next = dialogs[dialogs.length - 1] || null;
    if (next === activeDialog) return;
    // Restore only the nodes made inert by this controller.
    document.querySelectorAll('[data-app-inert]').forEach((el) => {
      el.inert = originals.get(el) || false;
      el.removeAttribute('data-app-inert');
    });
    const previous = activeDialog;
    const previousFocus = previous ? returnTargets.get(previous) : null;
    activeDialog = next;
    document.querySelectorAll('[data-app-dialog-active]').forEach((el) => el.removeAttribute('data-app-dialog-active'));
    if (next) {
      (next.closest('.reauth-layer') || next).setAttribute('data-app-dialog-active', '');
      if (!returnTargets.has(next)) {
        const target = previous && dialogFocus.get(previous) || document.activeElement;
        if (target && !next.contains(target)) returnTargets.set(next, target);
      }
      let child = next;
      while (child.parentElement && child.parentElement !== document.documentElement) {
        for (const sibling of child.parentElement.children) {
          if (sibling === child || sibling.matches('script,style,.notification-center,#ambientCanvas')) continue;
          if (!sibling.inert) {
            originals.set(sibling, false);
            sibling.inert = true;
            sibling.setAttribute('data-app-inert', '');
          }
        }
        child = child.parentElement;
      }
      if (previousFocus?.isConnected && next.contains(previousFocus) && !previousFocus.closest('[inert],[hidden]')) {
        previousFocus.focus({ preventScroll: true });
      } else if (!next.contains(document.activeElement)) {
        const target = [...next.querySelectorAll(focusableSelector)].find((el) => !el.closest('[hidden],[inert]') && el.getClientRects().length);
        (target || next).focus({ preventScroll: true });
      }
    } else if (previous && previousFocus?.isConnected && !previousFocus.closest('[inert],[hidden]')) {
      previousFocus.focus({ preventScroll: true });
    }
    if (previous && !dialogs.includes(previous)) { returnTargets.delete(previous); dialogFocus.delete(previous); }
    document.documentElement.classList.toggle('app-dialog-open', Boolean(next));
    document.dispatchEvent(new CustomEvent('zentra:dialog-change'));
    reserveNoticeSpace();
  };
  const upgradeIcons = (root) => {
    const icons = [...(root.querySelectorAll?.('i.fa-spinner:not(.activity-indicator)') || [])];
    if (root.matches?.('i.fa-spinner:not(.activity-indicator)')) icons.push(root);
    for (const icon of icons) {
      icon.classList.remove('fa-spin');
      icon.classList.add('activity-indicator');
      icon.innerHTML = spinnerMarkup().replace(/^<span[^>]*>/, '').replace(/<\/span>$/, '');
      icon.setAttribute('aria-hidden', 'true');
    }
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const target = mutation.target;
        const opened = (mutation.attributeName === 'hidden' && !target.hidden)
          || (mutation.attributeName === 'aria-hidden' && target.getAttribute('aria-hidden') === 'false')
          || (mutation.attributeName === 'class' && target.classList.contains('is-open'));
        if (opened && !target.closest('[hidden],[aria-hidden="true"]')) {
          const dialogs = target.matches('[role="dialog"]') ? [target] : [...target.querySelectorAll('[role="dialog"]')];
          for (const dialog of dialogs) if (!dialog.closest('[hidden],[aria-hidden="true"]')) openedAt.set(dialog, ++dialogSequence);
        }
      }
      if (mutation.type === 'childList') mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        upgradeIcons(node);
        const dialogs = node.matches('[role="dialog"]') ? [node] : [...node.querySelectorAll('[role="dialog"]')];
        for (const dialog of dialogs) if (!dialog.closest('[hidden],[aria-hidden="true"]')) openedAt.set(dialog, ++dialogSequence);
      });
      else if (mutation.target.matches?.('i.fa-spinner:not(.activity-indicator)')) upgradeIcons(mutation.target);
    }
    synchronize();
    reserveNoticeSpace();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class'] });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !activeDialog) return;
    const items = [...activeDialog.querySelectorAll(focusableSelector)].filter((el) => !el.closest('[hidden],[inert]') && el.getClientRects().length);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || !activeDialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !activeDialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
  document.addEventListener('focusin', (event) => {
    if (activeDialog?.contains(event.target)) dialogFocus.set(activeDialog, event.target);
    if (activeDialog && !activeDialog.contains(event.target) && !event.target.closest('.notification-center')) {
      const target = [...activeDialog.querySelectorAll(focusableSelector)].find((el) => !el.closest('[hidden],[inert]') && el.getClientRects().length);
      target?.focus({ preventScroll: true });
    }
  });
  document.querySelectorAll('input,textarea,select').forEach((field) => {
    if (field.type === 'hidden') return;
    if (!field.labels?.length && !field.hasAttribute('aria-label') && !field.hasAttribute('aria-labelledby')) {
      const label = field.closest('label');
      const text = label?.querySelector('span')?.textContent || field.placeholder;
      if (text) field.setAttribute('aria-label', text.trim());
    }
  });
  document.addEventListener('input', (event) => {
    const field = event.target;
    if (!field.matches?.('input,textarea,select')) return;
    clearFieldError(field);
  });
  document.addEventListener('invalid', (event) => {
    const field = event.target;
    if (!field.matches?.('input,textarea,select')) return;
    setFieldError(field, field.validity.valueMissing ? 'Bu alanı doldurun.' : field.validationMessage || 'Bu alanı kontrol edin.');
  }, true);
  synchronize();
  window.addEventListener('resize', reserveNoticeSpace, { passive: true });
  window.visualViewport?.addEventListener('resize', reserveNoticeSpace, { passive: true });
  upgradeIcons(document);
}
