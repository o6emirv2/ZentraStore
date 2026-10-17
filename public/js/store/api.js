import { readApiJson, waitForSignal, requestController, compatibleStoreWrites, compatiblePrivateReads } from '../request-utils.js?v=zentra-ui-v80';

const DEFAULT_API_BASE = 'https://emirhan-siye.onrender.com';
const DEFAULT_TIMEOUT_MS = 9000;

let tokenProvider = null;
let appCheckTokenProvider = null;
let runtimePromise = null;

const USER_MESSAGES = Object.freeze({
  SHOPIER_DISABLED: 'Kartla ödeme şu anda kapalı. Diğer sipariş yöntemlerini kullanabilirsiniz.',
  SHOPIER_CONFIGURATION_INVALID: 'Kartla ödeme bağlantısı şu anda hazır değil. Siparişinizin durumunu kontrol edin veya destek alın.',
  SHOPIER_TIMEOUT: 'Shopier zamanında yanıt vermedi. Aynı işlemi kontrol ederek devam edin; yeni sipariş başlatmayın.',
  SHOPIER_CONNECTION_FAILED: 'Ödeme bağlantısı kurulamadı. Aynı işlemi tekrar kontrol edin.',
  SHOPIER_PENDING_LIMIT: 'İki Shopier siparişiniz ödeme bekliyor. Önce bu siparişleri kontrol edin.',
  SHOPIER_API_ERROR: 'Shopier işlemi şu anda tamamlanamıyor. Sipariş durumunu kontrol edip yeniden deneyin.',
  SHOPIER_RATE_LIMITED: 'Ödeme hizmeti yoğun. Kısa bir süre sonra aynı işlemi kontrol edin.',
  SHOPIER_PAYMENT_URL_INVALID: 'Ödeme bağlantısı güvenli biçimde doğrulanamadı. Sipariş numaranızla destek alın.',
  STORE_PRICE_CHANGED: 'Ürünün fiyatı değişti. İşlem uygulanmadı; güncel sepetinizi kontrol edin.',
  STORE_CATALOG_CHANGED: 'Satın alma sırasında ürün bilgileri değişti. İşlem uygulanmadı; güncel sepetinizi kontrol edin.',
  STORE_BALANCE_RECORD_INVALID: 'Bakiyenizi güvenli biçimde doğrulayamadık. İşlem yapılmadı; destek ekibiyle iletişime geçin.',
  STORE_KEY_DECRYPTION_FAILED: 'Teslimat kaydı güvenli biçimde açılamadı. Yeniden satın almayın; sipariş numaranızla destek alın.',
  STORE_KEY_CIPHERTEXT_INVALID: 'Teslimat kaydı doğrulanamadı. Sipariş numaranızla destek alın.',
  STORE_KEY_DECRYPTION_KEY_MISSING: 'Teslimat şu anda açılamıyor. Sipariş numaranızla destek alın.',
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
  AUTH_RECENT_LOGIN_REQUIRED: 'Oturum oluşturmak için hesabınıza yeniden giriş yapın.',
  STORE_AUTOMATIC_PRODUCT_DISABLED: 'Bu ürünün otomatik satışı kapalı. Açık olan Telegram kanalını kullanabilirsiniz.',
  STORE_AUTOMATIC_CHANNEL_DISABLED: 'Bakiye ile otomatik teslimat şu anda kullanıma kapalı.',
  STORE_TELEGRAM_ONLY_PRODUCT: 'Bu ürün yalnızca Telegram üzerinden sipariş edilebilir. Otomatik teslimat ve bakiye ile satın alma bu ürün için kullanılamaz.',
  STORE_AUTOMATIC_INVENTORY_DISABLED: 'Bu ürün için otomatik stok ve stok bildirimi bulunmuyor. Lütfen Telegram üzerinden iletişime geçin.',
  STORE_DELIVERY_NOT_READY: 'Teslimat ödeme onayından sonra açılacak.',
  STORE_DELIVERY_KEY_NOT_AVAILABLE: 'Bu sipariş için açılabilir teslimat bulunamadı.',
  STORE_DELIVERY_AUDIT_UNAVAILABLE: 'Güvenli teslimat kaydı oluşturulamadığı için bilgiler gösterilmedi.',
  STORE_DELIVERY_INTEGRITY_ERROR: 'Teslimat bilgileri güvenli biçimde doğrulanamadığı için görüntülenmedi.',
  STORE_KEY_CONTEXT_INVALID: 'Teslimat kaydı hesabınla güvenli biçimde eşleştirilemedi.',
  STORE_ACCOUNT_SUSPENDED: 'Bu hesap geçici olarak askıya alınmış. Lütfen destek ekibiyle iletişime geçin.',
  STORE_CATALOG_PERSISTENCE_UNAVAILABLE: 'Güncel ürün fiyatları şu anda doğrulanamıyor. Lütfen kısa süre sonra yeniden deneyin.',
  STORE_PRODUCT_NOT_FOUND: 'Seçtiğiniz ürün artık satışta değil veya bulunamadı.',
  STORE_SKU_INVALID: 'Seçtiğiniz ürün paketi doğrulanamadı. Lütfen ürün listesini yenileyin.',
  STORE_NOTIFICATION_ID_REQUIRED: 'Seçilen bildirim artık kullanılamıyor.',
  BALANCE_CODE_INPUT_INVALID: 'Yalnızca geçerli promosyon kodunu girin.',
  BALANCE_CODE_NOT_FOUND: 'Bu promosyon kodu bulunamadı. Kodu ve seçtiğiniz kod türünü kontrol edin.',
  BALANCE_CODE_INACTIVE: 'Bu promosyon kodu şu anda kullanıma kapalı.',
  BALANCE_CODE_NOT_STARTED: 'Bu promosyon kodunun kullanım dönemi henüz başlamadı.',
  BALANCE_CODE_EXPIRED: 'Bu promosyon kodunun kullanım süresi doldu.',
  BALANCE_CODE_LIMIT_REACHED: 'Bu promosyon kodunun kullanım hakkı doldu.',
  BALANCE_CODE_CONFIGURATION_INVALID: 'Promosyon kodunun ayarları doğrulanamadı. Destek ekibine ulaşın.',
  BALANCE_CODE_RECEIPT_INVALID: 'Kod kullanım kaydı doğrulanamadı. Destek ekibine ulaşın.',
  BALANCE_CODE_USE_ACCOUNT: 'Promosyon kodunu Hesabım → Kuponlarım alanında kullanın.',
  STORE_PROMOTION_CODE_INVALID: 'İndirim kodu geçersiz. Kodu kontrol edip yeniden deneyin.',
  CLIENT_UPDATE_REQUIRED: 'Mağaza sürümü yenilendi. Devam etmek için sayfayı yenileyin.',
  CLIENT_ACCOUNT_UPDATE_REQUIRED: 'Hesap bilgilerini güvenli yüklemek için sunucu da güncel proje ile yayınlanmalıdır.',
  AUTH_INITIALIZATION_TIMEOUT: 'Hesap bağlantısı zamanında kurulamadı. Yeniden deneyin.',
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
  STORE_INSUFFICIENT_BALANCE: 'ZENTRA STORE bakiyeniz bu sipariş için yeterli değil.',
  STORE_ORDER_CONFLICT: 'Bu sipariş isteği daha önce farklı bilgilerle kullanılmış. Lütfen sepetinizi yenileyip yeniden deneyin.',
  STORE_ORDER_ATTEMPT_CANCELLED: 'Bu satın alma isteği güvenle iptal edilmiş. Yeni sipariş için sepetinizi yeniden kontrol edin.',
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
  AUTH_OPERATION_PENDING: 'Hesap işlemi devam ediyor. Tamamlanmasını bekleyin.',
  REGISTER_PENDING: 'Başlayan kaydı aynı e-posta ile Kayıt Ol alanından tamamlayın.',
  AUTH_ACCOUNT_MISMATCH: 'Hesap bilgisi oturumunuzla eşleşmedi. Yeniden giriş yapın.',
  PASSWORD_CHANGE_UNCERTAIN: 'Şifre değişiminin sonucu doğrulanamadı. Yeni şifrenizle girişinizi kontrol edin; aynı işlemi tekrar göndermeyin.',
  INVALID_JSON: 'Gönderilen bilgiler okunamadı. Lütfen alanları kontrol edip yeniden deneyin.',
  REQUEST_BODY_TOO_LARGE: 'Gönderilen bilgi boyutu izin verilen sınırı aşıyor.'
});

function normalizeBase(value = '') {
  return String(value || '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
}

export function getStoreApiBase() {
  const metaBase = document.querySelector('meta[name="zentra-api-origin"]')?.content || '';
  return normalizeBase(window.__ZENTRA_RUNTIME__?.apiBase || metaBase || DEFAULT_API_BASE);
}

function runtimeCandidates() {
  const metaBase = normalizeBase(document.querySelector('meta[name="zentra-api-origin"]')?.content || '');
  const configured = normalizeBase(window.__ZENTRA_RUNTIME__?.apiBase || '');
  // Prefer the first-party API. A separate static host can still use the configured backend fallback.
  const values = configured ? [configured, '', metaBase, DEFAULT_API_BASE] : ['', metaBase, DEFAULT_API_BASE];
  return [...new Set(values.map(normalizeBase))];
}

async function fetchRuntimeCandidate(base = '', timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/public/runtime-config`, {
      headers: { Accept: 'application/json', 'X-Zentra-Store-Client': 'runtime-bootstrap-v67' },
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal
    });
    const contentType = String(response.headers.get('content-type') || '');
    if (!response.ok || !contentType.includes('application/json')) return null;
    const payload = await response.json().catch(() => null);
    if (payload?.ok === true && (!Number.isSafeInteger(payload.version) || payload.version < 1)) throw Object.assign(new Error('Sunucu sürümü doğrulanamadı.'), { code: 'CLIENT_VERSION_MISMATCH' });
    return payload?.ok === true ? payload : null;
  } catch (error) {
    if (error?.code === 'CLIENT_VERSION_MISMATCH') throw error;
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function loadStoreRuntimeConfig({ force = false } = {}) {
  if (!force && window.__ZENTRA_RUNTIME__?.firebaseReady) return window.__ZENTRA_RUNTIME__;
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    for (const base of runtimeCandidates()) {
      const payload = await fetchRuntimeCandidate(base, base ? 6500 : 3200);
      if (!payload) continue;
      const apiBase = base === '' ? normalizeBase(window.location.origin) : normalizeBase(base);
      window.__ZENTRA_RUNTIME__ = Object.assign({}, window.__ZENTRA_RUNTIME__ || {}, payload, { apiBase });
      window.dispatchEvent(new CustomEvent('zentra:runtime-updated'));
      return window.__ZENTRA_RUNTIME__;
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
  if (/auth\/weak-password/i.test(code)) return 'Şifreniz en az 8 karakter olmalıdır.';
  if (/auth\/requires-recent-login/i.test(code)) return 'Bu güvenlik işlemi için mevcut şifrenizle yeniden doğrulama yapmanız gerekiyor.';
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
  let mutationSent = false;
  const requestTokenProvider = tokenProvider;
  const timeoutMs = Math.min(60_000, Math.max(1500, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const request = requestController(timeoutMs, options.signal);
  const { controller } = request;
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  headers.set('X-Request-Id', headers.get('X-Request-Id') || createRequestId());
  headers.set('X-Zentra-Store-Client', 'premium-store-v78');
  if (options.body !== undefined && options.body !== null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const rawPath = String(path || '');
  const url = /^https?:\/\//i.test(rawPath) ? rawPath : `${getStoreApiBase()}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`;
  try {
    const destination = new URL(url, window.location.href), base = new URL(getStoreApiBase() || window.location.origin, window.location.href);
    if (destination.origin !== base.origin || destination.username || destination.password || !['https:', 'http:'].includes(destination.protocol)) throw Object.assign(new Error('İstek adresi mağazayla eşleşmedi.'), { code: 'API_ORIGIN_INVALID', mutationNotSent: true });
    const method = String(options.method || (options.body === undefined ? 'GET' : 'POST')).toUpperCase();
    const protectedStore = options.auth !== false && (destination.pathname.startsWith('/api/store/') || destination.pathname.startsWith('/api/payments/')) && destination.pathname !== '/api/store/catalog';
    if (protectedStore && ['GET', 'HEAD'].includes(method) && !compatiblePrivateReads(window.__ZENTRA_RUNTIME__)) throw Object.assign(new Error(USER_MESSAGES.CLIENT_ACCOUNT_UPDATE_REQUIRED), { code: 'CLIENT_ACCOUNT_UPDATE_REQUIRED', mutationNotSent: true });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && (destination.pathname.startsWith('/api/store/') || destination.pathname.startsWith('/api/payments/') || destination.pathname === '/api/profile/update') && !compatibleStoreWrites(window.__ZENTRA_RUNTIME__)) throw Object.assign(new Error(USER_MESSAGES.CLIENT_UPDATE_REQUIRED), { code: 'CLIENT_UPDATE_REQUIRED', mutationNotSent: true });
    if (options.auth !== false && requestTokenProvider) {
      let token;
      try { token = await waitForSignal(Promise.resolve().then(() => requestTokenProvider()), controller.signal); }
      catch (error) {
        if (/auth\/(?:user-token-expired|invalid-user-token|user-disabled|user-not-found)/i.test(String(error?.code || ''))) throw Object.assign(new Error(USER_MESSAGES.AUTH_INVALID), { code: 'AUTH_INVALID', mutationNotSent: true });
        if (controller.signal.aborted) throw error;
        throw Object.assign(new Error(USER_MESSAGES.NETWORK_ERROR), { code: 'NETWORK_ERROR', mutationNotSent: true });
      }
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    if (appCheckTokenProvider) {
      const appCheckToken = await waitForSignal(Promise.resolve().then(() => appCheckTokenProvider()).catch(() => ''), controller.signal);
      if (appCheckToken) headers.set('X-Firebase-AppCheck', appCheckToken);
    }
  
    if (options.auth !== false && tokenProvider !== requestTokenProvider) {
      const error = new Error(USER_MESSAGES.AUTH_SESSION_CHANGED);
      error.code = 'AUTH_SESSION_CHANGED';
      throw error;
    }
    if ((protectedStore || options.auth === 'bearer') && !headers.has('Authorization')) {
      const error = new Error(USER_MESSAGES.AUTH_FRESH_TOKEN_REQUIRED);
      error.code = 'AUTH_FRESH_TOKEN_REQUIRED';
      throw error;
    }
    mutationSent = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const response = await fetch(url, {
      method: options.method || (options.body !== undefined ? 'POST' : 'GET'),
      headers,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      redirect: 'error',
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
      if (!request.timedOut) throw new DOMException('Request cancelled', 'AbortError');
      const timeoutError = new Error(USER_MESSAGES.REQUEST_TIMEOUT);
      timeoutError.code = 'REQUEST_TIMEOUT';
      timeoutError.mutationNotSent = !mutationSent;
      throw timeoutError;
    }
    if (error instanceof TypeError) {
      const networkError = new Error(USER_MESSAGES.NETWORK_ERROR);
      networkError.code = 'NETWORK_ERROR';
      networkError.mutationNotSent = !mutationSent;
      throw networkError;
    }
    if (!mutationSent) error.mutationNotSent = true;
    throw error;
  } finally {
    request.cleanup();
  }
}
