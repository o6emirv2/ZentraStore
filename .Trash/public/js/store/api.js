import { readApiJson, waitForSignal } from '../request-utils.js?v=audit-20260908-v1';

const DEFAULT_API_BASE = 'https://emirhan-siye.onrender.com';
const DEFAULT_TIMEOUT_MS = 9000;

let tokenProvider = null;
let appCheckTokenProvider = null;
let runtimePromise = null;

const USER_MESSAGES = Object.freeze({
  AUTH_REQUIRED: 'Devam etmek için lütfen hesabınıza giriş yapın.',
  AUTH_INVALID: 'Oturumunuzu doğrulayamadık. Lütfen yeniden giriş yapın.',
  AUTH_SESSION_CHANGED: 'Hesap oturumunuz değiştiği için güvenli işlem durduruldu. Lütfen yeniden deneyin.',
  LOGIN_CREDENTIALS_INVALID: 'E-posta, kullanıcı adı veya şifre hatalı.',
  AUTH_UNAVAILABLE: 'Hesap işlemleri şu anda kullanılamıyor. Lütfen sayfayı yenileyip yeniden deneyin.',
  SESSION_INVALID: 'Oturumunuz sona erdi. Lütfen yeniden giriş yapın.',
  ORIGIN_NOT_ALLOWED: 'Bu işlem güvenlik nedeniyle tamamlanamadı.',
  STORE_STORAGE_UNAVAILABLE: 'Mağaza hesap işlemleri şu anda kullanılamıyor. Lütfen kısa bir süre sonra yeniden deneyin.',
  STORE_INDEX_REQUIRED: 'Sipariş geçmişi hazırlanıyor. Lütfen kısa bir süre sonra yeniden deneyin.',
  STORE_PAGE_CURSOR_INVALID: 'Geçmiş kayıtlar yenilendi. Lütfen listeyi baştan yükleyin.',
  STORE_CART_INVALID: 'Sepet bilgilerinizi doğrulayamadık. Lütfen sepetinizi yenileyin.',
  STORE_ITEM_UNAVAILABLE: 'Sepetinizdeki ürünlerden biri artık satışta değil.',
  STORE_OUT_OF_STOCK: 'Seçtiğiniz paket için yeterli stok kalmadı. Dilerseniz stok bildirimi oluşturabilirsiniz.',
  STORE_STOCK_CONFLICT: 'Son stok başka bir siparişe ayrıldı. Lütfen stokları yenileyip yeniden deneyin.',
  AUTH_FRESH_TOKEN_REQUIRED: 'Güvenli oturumunuzu yenileyemedik. Lütfen hesabınızdan çıkış yapıp yeniden giriş yapın.',
  STORE_PURCHASE_BLOCKED: 'Bu hesapta satın alma işlemleri geçici olarak sınırlandırılmış.',
  STORE_MAINTENANCE_ACTIVE: 'Mağaza kısa süreli bakımdadır. Lütfen biraz sonra yeniden deneyin.',
  STORE_TELEGRAM_CHANNEL_DISABLED: 'Telegram sipariş kanalı şu anda kullanıma kapalı.',
  STORE_TELEGRAM_PRODUCT_DISABLED: 'Bu ürün için Telegram sipariş kanalı şu anda kapalı.',
  STORE_AUTOMATIC_CHANNEL_DISABLED: 'Bakiye ile otomatik teslimat şu anda kullanıma kapalı.',
  STORE_TELEGRAM_ONLY_PRODUCT: 'Bu ürün yalnızca Telegram üzerinden sipariş edilebilir. Otomatik teslimat ve bakiye ile satın alma bu ürün için kullanılamaz.',
  STORE_AUTOMATIC_INVENTORY_DISABLED: 'Bu ürün için otomatik stok ve stok bildirimi bulunmuyor. Lütfen Telegram üzerinden iletişime geçin.',
  STORE_PROVIDER_MIXED_CART_UNSUPPORTED: 'Bu ürünleri aynı sepet içinde güvenli biçimde tamamlayamıyoruz. Lütfen ilgili paketi ayrı bir sipariş olarak satın alın.',
  STORE_PROVIDER_SINGLE_ITEM_REQUIRED: 'Bu paket güvenli otomatik teslimat için her siparişte 1 adet satın alınabilir.',
  STORE_PROVIDER_OUT_OF_STOCK: 'Seçtiğiniz paket az önce tükendi. Bakiyenizden herhangi bir kalıcı kesinti yapılmadı.',
  STORE_PROVIDER_PURCHASE_UNAVAILABLE: 'Bu ürün şu anda geçici olarak otomatik satın alınamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  STORE_PROVIDER_PRICE_UNVERIFIED: 'Ürün fiyatı satın alma öncesinde güvenli biçimde doğrulanamadı. İşlem uygulanmadı.',
  STORE_PROVIDER_BALANCE_UNAVAILABLE: 'Bu ürün şu anda geçici olarak satın alınamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_OUT_OF_STOCK: 'Seçtiğiniz paket az önce tükendi. Bakiyenizden herhangi bir kalıcı kesinti yapılmadı.',
  PROVIDER_PRICE_CHANGED: 'Ürün fiyatı satın alma sırasında değişti. İşlem güvenli şekilde durduruldu ve bakiyenizden kalıcı kesinti yapılmadı.',
  PROVIDER_INSUFFICIENT_BALANCE: 'Bu ürün şu anda geçici olarak satın alınamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_PURCHASE_REJECTED: 'Satın alma işlemi tamamlanamadı. Bakiyeniz güvenli şekilde korunmuştur.',
  PROVIDER_LOGIN_INVALID: 'Bu ürün şu anda geçici olarak satın alınamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_LOGIN_UNVERIFIED: 'Bu ürün şu anda geçici olarak satın alınamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_SESSION_EXPIRED: 'Bu ürün şu anda geçici olarak satın alınamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_CAPTCHA_REQUIRED: 'Bu ürün şu anda geçici olarak satın alınamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_OTP_REQUIRED: 'Bu ürün şu anda geçici olarak satın alınamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_NETWORK_ERROR: 'Ürünün güncel stok bilgisi şu anda doğrulanamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_ACCESS_BLOCKED: 'Bu ürünün güncel tedarik bilgisi şu anda doğrulanamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_SERVICE_UNAVAILABLE: 'Bu ürünün güncel tedarik bilgisi şu anda kullanılamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_RESPONSE_TOO_LARGE: 'Ürün doğrulaması güvenlik nedeniyle durduruldu. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_REDIRECT_INVALID: 'Ürün doğrulaması güvenlik nedeniyle durduruldu. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_REDIRECT_LIMIT: 'Ürün doğrulaması güvenlik nedeniyle durduruldu. Lütfen kısa süre sonra yeniden deneyin.',
  PROVIDER_STOCK_UNVERIFIED: 'Ürünün güncel stoğu doğrulanamadığı için satın alma güvenli şekilde durduruldu.',
  PROVIDER_PURCHASE_FORM_UNAVAILABLE: 'Bu ürün şu anda geçici olarak otomatik satın alınamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  STORE_DELIVERY_NOT_READY: 'Teslimat ödeme onayından sonra açılacak.',
  STORE_DELIVERY_KEY_NOT_AVAILABLE: 'Bu sipariş için açılabilir teslimat bulunamadı.',
  STORE_DELIVERY_AUDIT_UNAVAILABLE: 'Güvenli teslimat kaydı oluşturulamadığı için bilgiler gösterilmedi.',
  STORE_DELIVERY_INTEGRITY_ERROR: 'Teslimat bilgileri güvenli biçimde doğrulanamadığı için görüntülenmedi.',
  STORE_KEY_DECRYPTION_KEY_MISSING: 'Bu teslimatın güvenlik anahtarı bulunamadı. Lütfen destek ekibiyle iletişime geçin.',
  STORE_KEY_DECRYPTION_FAILED: 'Teslimat kaydı güvenli biçimde açılamadı. Lütfen destek ekibiyle iletişime geçin.',
  STORE_KEY_CIPHERTEXT_INVALID: 'Teslimat kaydı doğrulanamadığı için bilgiler güvenlik amacıyla gösterilmedi.',
  STORE_KEY_CONTEXT_INVALID: 'Teslimat kaydı hesabınla güvenli biçimde eşleştirilemedi.',
  STORE_ACCOUNT_SUSPENDED: 'Bu hesap geçici olarak askıya alınmış. Lütfen destek ekibiyle iletişime geçin.',
  STORE_CATALOG_PERSISTENCE_UNAVAILABLE: 'Güncel ürün fiyatları şu anda doğrulanamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  STORE_PRODUCT_NOT_FOUND: 'Seçtiğiniz ürün artık satışta değil veya bulunamadı.',
  STORE_SKU_INVALID: 'Seçtiğiniz ürün paketi doğrulanamadı. Lütfen ürün listesini yenileyin.',
  STORE_NOTIFICATION_ID_REQUIRED: 'Seçilen bildirim artık kullanılamıyor.',
  STORE_PROMOTION_CODE_INVALID: 'İndirim kodu geçersiz. Kodu kontrol edip yeniden deneyin.',
  STORE_PROMOTION_NOT_FOUND: 'Bu indirim kodu bulunamadı veya artık aktif değil.',
  STORE_PROMOTION_EXPIRED: 'Bu kampanyanın kullanım süresi dolmuş veya henüz başlamamış.',
  STORE_PROMOTION_LIMIT_REACHED: 'Bu kampanyanın toplam kullanım limiti dolmuş.',
  STORE_PROMOTION_ALREADY_USED: 'Bu indirim kodunu hesabınız için izin verilen sayıda kullandınız.',
  STORE_PROMOTION_MINIMUM_NOT_MET: 'Sepetiniz kampanyanın minimum tutar şartını karşılamıyor.',
  STORE_PROMOTION_SCOPE_INVALID: 'Bu kampanya sepetinizdeki ürünler veya platform için geçerli değil.',
  STORE_PROMOTION_REDEMPTION_INVALID: 'Kampanya kullanım kaydı doğrulanamadı. Lütfen destek ekibiyle iletişime geçin.',
  STORE_PROMOTION_UNAVAILABLE: 'Kampanya şu anda doğrulanamadı. Lütfen biraz sonra yeniden deneyin.',
  STORE_KEY_VAULT_UNAVAILABLE: 'Güvenli teslimat alanı hazırlanıyor. Lütfen biraz sonra yeniden deneyin.',
  APP_CHECK_REQUIRED: 'Güvenli işlem doğrulaması tamamlanamadı. Lütfen sayfayı yenileyip yeniden deneyin.',
  APP_CHECK_INVALID: 'Güvenli işlem oturumu sona erdi. Lütfen sayfayı yenileyip yeniden deneyin.',
  STORE_ORDER_TOTAL_INVALID: 'Sipariş toplamı doğrulanamadı.',
  STORE_PAYMENT_METHOD_INVALID: 'Ödeme yöntemi doğrulanamadı.',
  STORE_ACCOUNT_DISABLED: 'Hesabınız güvenlik nedeniyle kullanıma kapatılmış. Lütfen destek ekibiyle iletişime geçin.',
  STORE_ACCOUNT_NOT_FOUND: 'Hesap bilgilerinizi doğrulayamadık. Lütfen yeniden giriş yapın.',
  STORE_INSUFFICIENT_BALANCE: 'SHELBY STORE bakiyeniz bu sipariş için yeterli değil.',
  STORE_ORDER_CONFLICT: 'Bu sipariş isteği daha önce farklı bilgilerle kullanılmış. Lütfen sepetinizi yenileyip yeniden deneyin.',
  STORE_ORDER_NOT_FOUND: 'Sipariş bulunamadı veya artık erişilebilir değil.',
  STORE_ORDER_ID_REQUIRED: 'Sipariş bilgisi eksik. Lütfen sipariş listenizi yenileyin.',
  STORE_ORDER_CREATE_FAILED: 'Sipariş oluşturulamadı. Bakiyeniz ve stok bilgileriniz güvenle korundu.',
  STORE_ORDER_UPDATE_FAILED: 'Sipariş durumu şu anda güncellenemedi. Lütfen yeniden deneyin.',
  STORE_ORDER_TRANSITION_INVALID: 'Siparişin mevcut durumu bu işleme izin vermiyor.',
  STORE_ORDER_ACCESS_DENIED: 'Bu sipariş üzerinde işlem yapma yetkiniz bulunmuyor.',
  STORE_ORDER_CANCELLATION_NOT_ALLOWED: 'Bu sipariş hazırlanmaya başladığı için hesabınızdan iptal edilemez. Lütfen destek ekibiyle iletişime geçin.',
  STORE_ORDER_STATUS_INVALID: 'Sipariş durumu doğrulanamadı.',
  STORE_AVATAR_INVALID: 'Profil görseli seçimi doğrulanamadı.',
  USERNAME_TAKEN: 'Bu kullanıcı adı kullanılıyor.',
  USERNAME_RESERVED: 'Bu kullanıcı adı kullanılamaz. Lütfen farklı bir kullanıcı adı seçin.',
  USERNAME_UNCHANGED: 'Yeni kullanıcı adın mevcut kullanıcı adından farklı olmalıdır.',
  USERNAME_CHANGE_LIMIT_REACHED: 'Kullanıcı adı değiştirme hakkın doldu. Bu bilgi en fazla 3 kez değiştirilebilir.',
  USERNAME_AMBIGUOUS: 'Bu kullanıcı adıyla birden fazla eski kayıt bulundu. Lütfen e-posta adresinizle giriş yapın.',
  INVALID_USERNAME: 'Kullanıcı adı 5-20 karakter olmalı; harf, sayı, nokta, alt çizgi ve tire kullanılabilir.',
  INVALID_PERSON_NAME: 'İsim ve soyisim en az 2 karakter olmalı; harf, boşluk, kesme işareti ve tire kullanılabilir.',
  FULL_NAME_UNCHANGED: 'Yeni isim ve soyisim mevcut bilgilerinden farklı olmalıdır.',
  FULL_NAME_CHANGE_LIMIT_REACHED: 'İsim ve soyisim değiştirme hakkın doldu. Bu bilgi yalnızca 1 kez değiştirilebilir.',
  BIRTH_DATE_INVALID: 'Lütfen geçerli bir doğum tarihi seçin.',
  BIRTH_DATE_UNCHANGED: 'Yeni doğum tarihin mevcut tarihten farklı olmalıdır.',
  BIRTH_DATE_CHANGE_LIMIT_REACHED: 'Doğum tarihi değiştirme hakkın doldu. Bu bilgi yalnızca 1 kez değiştirilebilir.',
  PROFILE_INITIALIZATION_LOCKED: 'Hesap bilgileri yalnızca Hesabım bölümündeki korumalı işlemlerle değiştirilebilir.',
  PROFILE_INPUT_INVALID: 'Hesap bilgileri doğrulanamadı. Lütfen alanları kontrol edip yeniden dene.',
  EMAIL_INVALID: 'Lütfen geçerli bir e-posta adresi gir.',
  EMAIL_UNCHANGED: 'Yeni e-posta adresin mevcut adresinden farklı olmalıdır.',
  EMAIL_ALREADY_IN_USE: 'Bu e-posta adresi başka bir hesapta kullanılıyor.',
  EMAIL_UPDATE_UNAVAILABLE: 'E-posta adresin şu anda güncellenemedi. Lütfen kısa süre sonra yeniden dene.',
  STORE_AVATAR_URL_INVALID: 'Profil görseli doğrulanamadı. Lütfen hazır görsellerden birini seçin.',
  ID_TOKEN_REQUIRED: 'Hesap oturumunuz doğrulanamadı. Lütfen yeniden giriş yapın.',
  RATE_LIMIT_STORE_UNAVAILABLE: 'Güvenli işlem kontrolü şu anda kullanılamıyor. Lütfen biraz sonra yeniden deneyin.',
  SESSION_REVOCATION_FAILED: 'Oturum güvenle kapatılamadı. Lütfen kısa süre sonra yeniden deneyin.',
  TOO_MANY_REQUESTS: 'Çok fazla deneme yapıldı. Lütfen kısa bir süre bekleyip yeniden deneyin.',
  REQUEST_TIMEOUT: 'İşlem beklenenden uzun sürdü. Lütfen yeniden deneyin.',
  NETWORK_ERROR: 'Bağlantı kurulamadı. Lütfen internet bağlantınızı kontrol edip yeniden deneyin.',
  CURRENT_PASSWORD_INVALID: 'Mevcut şifre doğrulanamadı.',
  INVALID_JSON: 'Gönderilen bilgiler okunamadı. Lütfen alanları kontrol edip yeniden deneyin.',
  REQUEST_BODY_TOO_LARGE: 'Gönderilen bilgi boyutu izin verilen sınırı aşıyor.'
});

function normalizeBase(value = '') {
  return String(value || '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
}

export function getStoreApiBase() {
  const metaBase = document.querySelector('meta[name="shelby-api-origin"]')?.content || '';
  return normalizeBase(window.__SHELBY_RUNTIME__?.apiBase || metaBase || DEFAULT_API_BASE);
}

function runtimeCandidates() {
  const metaBase = normalizeBase(document.querySelector('meta[name="shelby-api-origin"]')?.content || '');
  const configured = normalizeBase(window.__SHELBY_RUNTIME__?.apiBase || '');
  const values = [configured, '', metaBase, DEFAULT_API_BASE];
  return [...new Set(values.map(normalizeBase))];
}

async function fetchRuntimeCandidate(base = '', timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/public/runtime-config`, {
      headers: { Accept: 'application/json', 'X-Shelby-Store-Client': 'runtime-bootstrap-v66' },
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal
    });
    const contentType = String(response.headers.get('content-type') || '');
    if (!response.ok || !contentType.includes('application/json')) return null;
    const payload = await response.json().catch(() => null);
    return payload?.ok === true ? payload : null;
  } catch (_) {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function loadStoreRuntimeConfig({ force = false } = {}) {
  if (!force && window.__SHELBY_RUNTIME__?.firebaseReady) return window.__SHELBY_RUNTIME__;
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    for (const base of runtimeCandidates()) {
      const payload = await fetchRuntimeCandidate(base, base ? 6500 : 3200);
      if (!payload) continue;
      const apiBase = base === '' ? normalizeBase(window.location.origin) : normalizeBase(payload.apiBase || base);
      window.__SHELBY_RUNTIME__ = Object.assign({}, window.__SHELBY_RUNTIME__ || {}, payload, { apiBase });
      window.dispatchEvent(new CustomEvent('shelby:runtime-updated'));
      return window.__SHELBY_RUNTIME__;
    }
    const error = new Error(USER_MESSAGES.NETWORK_ERROR);
    error.code = 'NETWORK_ERROR';
    throw error;
  })().finally(() => { runtimePromise = null; });
  return runtimePromise;
}

export function setStoreTokenProvider(provider) {
  tokenProvider = typeof provider === 'function' ? provider : null;
}

export function setStoreAppCheckTokenProvider(provider) {
  appCheckTokenProvider = typeof provider === 'function' ? provider : null;
}

let requestSequence = 0;

export function createRequestId(prefix = 'store') {
  try {
    if (window.crypto?.randomUUID) return `${prefix}_${window.crypto.randomUUID()}`;
  } catch (_) {}
  const bytes = new Uint8Array(12);
  try {
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes);
      return `${prefix}_${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    }
  } catch (_) {}
  // Correlation/idempotency identifier only; never used as an auth secret.
  const suffix = `${Date.now().toString(36)}_${++requestSequence}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${suffix}`;
}

export function friendlyStoreError(value, fallback = 'İşlem şu anda tamamlanamadı. Lütfen yeniden deneyin.') {
  const code = String(value?.code || value?.error || value || '').trim();
  const upper = code.toUpperCase();
  if (USER_MESSAGES[upper]) return USER_MESSAGES[upper];
  if (/auth\/invalid-credential|auth\/wrong-password|auth\/user-not-found/i.test(code)) return 'E-posta, kullanıcı adı veya şifre hatalı.';
  if (/auth\/email-already-in-use/i.test(code)) return 'Bu e-posta başka bir hesapta kullanılıyor.';
  if (/auth\/invalid-email/i.test(code)) return 'E-posta adresi geçersiz.';
  if (/auth\/weak-password|password-does-not-meet-requirements/i.test(code)) return 'Şifreniz en az 8 karakter olmalıdır.';
  if (/auth\/requires-recent-login/i.test(code)) return 'Bu güvenlik işlemi için mevcut şifrenizle yeniden doğrulama yapmanız gerekiyor.';
  if (/auth\/invalid-credential|auth\/wrong-password/i.test(code)) return 'Mevcut şifre doğrulanamadı.';
  if (/auth\/password-does-not-meet-requirements/i.test(code)) return 'Yeni şifre güvenlik kurallarını karşılamıyor.';
  if (/auth\/too-many-requests|too[_ -]?many/i.test(code)) return 'Çok fazla deneme yapıldı. Lütfen kısa bir süre sonra yeniden deneyin.';
  if (/auth\/network-request-failed|failed to fetch|networkerror|load failed/i.test(code)) return USER_MESSAGES.NETWORK_ERROR;
  const message = String(value?.message || '').trim();
  if (message && !/firebase|server|backend|endpoint|http[_ -]?\d{3}|internal|undefined|null|exception|stack|token/i.test(message)) {
    return message.slice(0, 180);
  }
  return fallback;
}

export async function storeApi(path, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.min(60_000, Math.max(1500, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  headers.set('X-Request-Id', headers.get('X-Request-Id') || createRequestId());
  headers.set('X-Shelby-Store-Client', 'premium-store-v66');
  if (options.body !== undefined && options.body !== null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const rawPath = String(path || '');
  const url = /^https?:\/\//i.test(rawPath) ? rawPath : `${getStoreApiBase()}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`;
  let sameOrigin = false;
  try { sameOrigin = new URL(url, window.location.href).origin === window.location.origin; } catch (_) {}
  try {
    if (options.auth !== false && tokenProvider && (!sameOrigin || options.auth === 'bearer')) {
      const token = await waitForSignal(Promise.resolve().then(() => tokenProvider()).catch(() => ''), controller.signal);
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    if (appCheckTokenProvider) {
      const appCheckToken = await waitForSignal(Promise.resolve().then(() => appCheckTokenProvider()).catch(() => ''), controller.signal);
      if (appCheckToken) headers.set('X-Firebase-AppCheck', appCheckToken);
    }
  
    if (options.auth === 'bearer' && !headers.has('Authorization')) {
      const error = new Error(USER_MESSAGES.AUTH_FRESH_TOKEN_REQUIRED);
      error.code = 'AUTH_FRESH_TOKEN_REQUIRED';
      throw error;
    }
    const response = await fetch(url, {
      method: options.method || (options.body !== undefined ? 'POST' : 'GET'),
      headers,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      body: options.body === undefined || options.body === null
        ? undefined
        : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
    });
    const payload = await readApiJson(response);
    if (!response.ok || payload?.ok === false) {
      const error = new Error(friendlyStoreError(payload?.error || payload?.code || payload?.message));
      error.code = String(payload?.code || payload?.error || `HTTP_${response.status}`).toUpperCase();
      error.status = response.status;
      error.payload = payload;
      error.requestId = String(payload.requestId || response.headers.get('x-request-id') || '');
      throw error;
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      const timeoutError = new Error(USER_MESSAGES.REQUEST_TIMEOUT);
      timeoutError.code = 'REQUEST_TIMEOUT';
      throw timeoutError;
    }
    if (error instanceof TypeError) {
      const networkError = new Error(USER_MESSAGES.NETWORK_ERROR);
      networkError.code = 'NETWORK_ERROR';
      throw networkError;
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}
