const NOTICE_TYPES = new Set(['success', 'error', 'warning', 'info']);

const TYPE_META = Object.freeze({
  success: Object.freeze({ title: 'İşlem tamamlandı', message: 'İşleminiz başarıyla tamamlandı.', icon: 'fa-check', scope: 'BAŞARILI' }),
  error: Object.freeze({ title: 'İşlem tamamlanamadı', message: 'Lütfen kısa bir süre sonra yeniden deneyin.', icon: 'fa-xmark', scope: 'UYARI' }),
  warning: Object.freeze({ title: 'Kontrol gerekli', message: 'Devam etmeden önce bilgileri kontrol edin.', icon: 'fa-exclamation', scope: 'DİKKAT' }),
  info: Object.freeze({ title: 'Bilgilendirme', message: 'İşleminizle ilgili yeni bir bilgi var.', icon: 'fa-info', scope: 'BİLGİ' })
});

const OPERATION_META = Object.freeze([
  { pattern: /teslim|dijital ürün|anahtar/i, scope: 'TESLİMAT', icons: ['fa-key', 'fa-lock-open', 'fa-shield-halved', 'fa-key'] },
  { pattern: /sipariş|ödeme|fatura/i, scope: 'SİPARİŞ', icons: ['fa-bag-shopping', 'fa-receipt', 'fa-clock', 'fa-receipt'] },
  { pattern: /bakiye|cüzdan|iade|tutar|rezerv/i, scope: 'BAKİYE', icons: ['fa-wallet', 'fa-money-bill-transfer', 'fa-coins', 'fa-wallet'] },
  { pattern: /kupon|kampanya|promosyon|indirim/i, scope: 'KUPON', icons: ['fa-ticket', 'fa-ticket-simple', 'fa-tag', 'fa-ticket'] },
  { pattern: /sepet/i, scope: 'SEPET', icons: ['fa-cart-plus', 'fa-cart-shopping', 'fa-cart-shopping', 'fa-bag-shopping'] },
  { pattern: /e-?posta|mail/i, scope: 'E-POSTA', icons: ['fa-envelope-circle-check', 'fa-envelope-open-text', 'fa-envelope', 'fa-envelope'] },
  { pattern: /şifre|parola|güvenlik|oturum|doğrula/i, scope: 'GÜVENLİK', icons: ['fa-shield-circle-check', 'fa-user-lock', 'fa-shield-halved', 'fa-fingerprint'] },
  { pattern: /giriş|hoş geld|hesabınız.*hazır/i, scope: 'HESAP', icons: ['fa-user-check', 'fa-user-xmark', 'fa-user-clock', 'fa-user-shield'] },
  { pattern: /çıkış/i, scope: 'OTURUM', icons: ['fa-arrow-right-from-bracket', 'fa-user-lock', 'fa-clock', 'fa-arrow-right-from-bracket'] },
  { pattern: /profil|avatar|kullanıcı adı|ad ve soyad|doğum/i, scope: 'PROFİL', icons: ['fa-user-pen', 'fa-user-xmark', 'fa-user-clock', 'fa-user-gear'] },
  { pattern: /stok|kasa|ürün|paket/i, scope: 'MAĞAZA', icons: ['fa-boxes-stacked', 'fa-box-open', 'fa-boxes-stacked', 'fa-store'] },
  { pattern: /kopya|pano/i, scope: 'KOPYALAMA', icons: ['fa-copy', 'fa-clipboard-question', 'fa-clipboard-check', 'fa-copy'] },
  { pattern: /bağlantı|internet|ağ|sunucu/i, scope: 'BAĞLANTI', icons: ['fa-wifi', 'fa-wifi', 'fa-tower-broadcast', 'fa-tower-broadcast'] }
]);

const TYPE_INDEX = Object.freeze({ success: 0, error: 1, warning: 2, info: 3 });

function safeText(value, fallback, limit) {
  return String(value || fallback || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function safeIcon(value = '') {
  const icon = String(value || '').trim().toLowerCase();
  return /^fa-[a-z0-9-]{2,48}$/.test(icon) ? icon : '';
}

function iconNode(name) {
  const icon = document.createElement('i');
  icon.className = `fa-solid ${name}`;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function presentation(type, title, message, options) {
  const base = TYPE_META[type];
  const match = OPERATION_META.find(({ pattern }) => pattern.test(title))
    || OPERATION_META.find(({ pattern }) => pattern.test(`${title} ${message}`));
  return {
    icon: safeIcon(options.icon) || match?.icons?.[TYPE_INDEX[type]] || base.icon,
    scope: safeText(options.scope, match?.scope || base.scope, 24)
  };
}

export function createNotificationCenter({
  host,
  brand = 'SHELBY STORE',
  soundUrl = '/public/assets/sounds/bildirim.wav',
  maxVisible = 2
} = {}) {
  if (!host) return { notify: () => null, clear: () => {}, destroy: () => {} };

  const timers = new Map();
  let audio = null;
  let audioReady = false;
  let lastFingerprint = '';
  let lastShownAt = 0;

  host.classList.add('notification-center');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-relevant', 'additions');
  host.setAttribute('aria-atomic', 'false');

  const unlockSound = () => {
    if (audioReady) return;
    if (!audio) {
      audio = new Audio(soundUrl);
      audio.preload = 'auto';
      audio.volume = 0.28;
      audio.playsInline = true;
    }
    const volume = audio.volume;
    audio.volume = 0;
    try {
      const attempt = audio.play();
      attempt?.then?.(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = volume;
        audioReady = true;
      }).catch?.(() => { audio.volume = volume; });
    } catch (_) {
      audio.volume = volume;
    }
  };

  const unlockOptions = { capture: true, passive: true };
  window.addEventListener('pointerdown', unlockSound, unlockOptions);
  window.addEventListener('touchstart', unlockSound, unlockOptions);
  window.addEventListener('keydown', unlockSound, { capture: true });

  const playSound = () => {
    if (!audioReady || !audio || document.visibilityState !== 'visible') return;
    try {
      audio.currentTime = 0;
      audio.play()?.catch?.(() => {});
    } catch (_) {}
  };

  const removeTimer = (notice) => {
    const timer = timers.get(notice);
    if (timer?.id) window.clearTimeout(timer.id);
    timers.delete(notice);
  };

  const dismiss = (notice, immediate = false) => {
    if (!notice?.isConnected) return;
    removeTimer(notice);
    if (immediate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      notice.remove();
      return;
    }
    notice.classList.remove('is-visible');
    notice.classList.add('is-leaving');
    window.setTimeout(() => notice.remove(), 220);
  };

  const startTimer = (notice, duration) => {
    if (!notice?.isConnected || timers.get(notice)?.id) return;
    const state = timers.get(notice) || { remaining: duration, startedAt: 0, id: 0 };
    state.startedAt = Date.now();
    state.id = window.setTimeout(() => dismiss(notice), state.remaining);
    timers.set(notice, state);
    notice.classList.remove('is-paused');
  };

  const pauseTimer = (notice) => {
    const state = timers.get(notice);
    if (!state?.id) return;
    window.clearTimeout(state.id);
    state.id = 0;
    state.remaining = Math.max(500, state.remaining - (Date.now() - state.startedAt));
    notice.classList.add('is-paused');
  };

  const resumeTimer = (notice, duration) => {
    if (notice.matches?.(':hover') || notice.contains(document.activeElement)) return;
    startTimer(notice, duration);
  };

  const keepStackCompact = () => {
    const notices = [...host.querySelectorAll('.shelby-notice')];
    const limit = window.matchMedia?.('(max-width: 560px)').matches
      ? 1
      : Math.max(1, Math.min(3, Number(maxVisible) || 2));
    while (notices.length >= limit) dismiss(notices.shift(), true);
  };

  function notify(type, title, message, options = {}) {
    const safeType = NOTICE_TYPES.has(type) ? type : 'info';
    const fallback = TYPE_META[safeType];
    const safeTitle = safeText(title, fallback.title, 86);
    const safeMessage = safeText(message, fallback.message, 220);
    const fingerprint = `${safeType}:${safeTitle}:${safeMessage}`;
    const now = Date.now();
    if (fingerprint === lastFingerprint && now - lastShownAt < 1_500) return null;
    lastFingerprint = fingerprint;
    lastShownAt = now;
    keepStackCompact();

    const actionLabel = safeText(options.actionLabel, '', 56);
    const duration = Math.max(3_800, Math.min(12_000, Number(options.duration) || (actionLabel ? 8_000 : 5_800)));
    const view = presentation(safeType, safeTitle, safeMessage, options);

    const notice = document.createElement('article');
    notice.className = `shelby-notice shelby-notice--${safeType}`;
    notice.style.setProperty('--notice-duration', `${duration}ms`);
    notice.setAttribute('role', safeType === 'error' ? 'alert' : 'status');
    notice.setAttribute('aria-label', `${safeTitle}. ${safeMessage}`);

    const symbol = document.createElement('span');
    symbol.className = 'shelby-notice__symbol';
    symbol.append(iconNode(view.icon));

    const content = document.createElement('span');
    content.className = 'shelby-notice__content';

    const meta = document.createElement('span');
    meta.className = 'shelby-notice__meta';
    const brandName = document.createElement('b');
    brandName.textContent = safeText(brand, 'SHELBY STORE', 36);
    const scope = document.createElement('em');
    scope.textContent = view.scope;
    const timestamp = document.createElement('small');
    timestamp.textContent = 'şimdi';
    meta.append(brandName, scope, timestamp);

    const heading = document.createElement('strong');
    heading.textContent = safeTitle;
    const body = document.createElement('span');
    body.className = 'shelby-notice__message';
    body.textContent = safeMessage;
    content.append(meta, heading, body);

    const close = document.createElement('button');
    close.className = 'shelby-notice__close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Bildirimi kapat');
    close.append(iconNode('fa-xmark'));
    close.addEventListener('click', () => dismiss(notice), { once: true });

    notice.append(symbol, content, close);

    if (actionLabel && typeof options.onAction === 'function') {
      const action = document.createElement('button');
      action.className = 'shelby-notice__action';
      action.type = 'button';
      const label = document.createElement('span');
      label.textContent = actionLabel;
      action.append(iconNode(safeIcon(options.actionIcon) || 'fa-arrow-right'), label);
      action.addEventListener('click', async () => {
        dismiss(notice);
        try { await options.onAction(); } catch (_) {}
      }, { once: true });
      notice.append(action);
    }

    const progress = document.createElement('span');
    progress.className = 'shelby-notice__progress';
    progress.setAttribute('aria-hidden', 'true');
    notice.append(progress);

    notice.addEventListener('pointerenter', () => pauseTimer(notice));
    notice.addEventListener('pointerleave', () => resumeTimer(notice, duration));
    notice.addEventListener('focusin', () => pauseTimer(notice));
    notice.addEventListener('focusout', (event) => {
      if (!notice.contains(event.relatedTarget)) resumeTimer(notice, duration);
    });

    host.prepend(notice);
    window.requestAnimationFrame(() => notice.classList.add('is-visible'));
    startTimer(notice, duration);
    if (options.sound !== false) playSound();
    return notice;
  }

  function clear() {
    [...host.querySelectorAll('.shelby-notice')].forEach((notice) => dismiss(notice, true));
  }

  function destroy() {
    clear();
    window.removeEventListener('pointerdown', unlockSound, unlockOptions);
    window.removeEventListener('touchstart', unlockSound, unlockOptions);
    window.removeEventListener('keydown', unlockSound, { capture: true });
    audio = null;
    audioReady = false;
  }

  return { notify, clear, destroy };
}
