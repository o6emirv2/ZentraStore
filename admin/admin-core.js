import { readApiJson, waitForSignal } from '../public/js/request-utils.js?v=audit-20260908-v1';

export function lockAdminInteractions() {
  document.documentElement.dataset.adminProtected = 'true';
}

export function startAmbientCanvas(canvas) {
  if (!canvas) return;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return;
  const reduced = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let width = 0;
  let height = 0;
  let points = [];
  let animation = 0;
  let previous = 0;
  let stopped = false;
  const resize = () => {
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    width = canvas.width = Math.round(innerWidth * ratio);
    height = canvas.height = Math.round(innerHeight * ratio);
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    points = Array.from({ length: Math.min(54, Math.max(20, Math.round(innerWidth / 24))) }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      radius: 1 + Math.random() * 2.2,
      speed: .12 + Math.random() * .36,
      alpha: .14 + Math.random() * .5
    }));
  };
  const draw = (time = 0) => {
    animation = 0;
    if (stopped || document.hidden) return;
    if (!reduced) animation = requestAnimationFrame(draw);
    if (time && time - previous < 40) return;
    previous = time;
    context.clearRect(0, 0, width, height);
    points.forEach((point) => {
      point.y -= point.speed;
      if (point.y < -10) { point.y = height + 10; point.x = Math.random() * width; }
      context.beginPath();
      context.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
      context.fillStyle = `rgba(255,55,72,${point.alpha})`;
      context.shadowBlur = 10;
      context.shadowColor = '#e51f32';
      context.fill();
    });
    context.shadowBlur = 0;
  };
  const visibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(animation);
      animation = 0;
    } else if (!animation && !stopped) {
      previous = 0;
      draw();
    }
  };
  resize();
  draw();
  addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', visibility);
  return () => {
    stopped = true;
    cancelAnimationFrame(animation);
    removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', visibility);
  };
}

function errorMessage(payload = {}, status = 0) {
  const code = String(payload.error || payload.code || '');
  const messages = {
    ADMIN_REQUIRED: 'Bu hesap yönetici izin listesinde bulunmuyor.',
    ADMIN_PERMISSION_REQUIRED: 'Bu işlem mevcut personel rolünün yetki kapsamı dışında.',
    ADMIN_OWNER_IMMUTABLE: 'Korunan mağaza sahibi kaydı personel yetkileriyle değiştirilemez.',
    ADMIN_GATE_REQUIRED: 'Lütfen güvenli yönetici giriş adımlarını yeniden tamamlayın.',
    ADMIN_GATE_FACTOR_REQUIRED: 'Güvenli yönetici doğrulamasının süresi dolmuş. Hesap şifresi adımından yeniden başlayın.',
    ADMIN_GATE_ACCESS_INVALID: 'Yönetici erişim oturumu geçersiz veya süresi dolmuş. Güvenli kapıyı yeniden tamamlayın.',
    ADMIN_STEP_SESSION_INVALID: 'Güvenlik adımı zaman aşımına uğradı. Lütfen baştan deneyin.',
    ADMIN_EMAIL_CONFIGURATION_INVALID: 'Yönetici e-posta yetkisi tamamlanmamış. Mağaza sahibiyle iletişime geçin.',
    ADMIN_UID_CONFIGURATION_INVALID: 'Yönetici hesap yetkisi tamamlanmamış. Mağaza sahibiyle iletişime geçin.',
    ADMIN_IDENTITY_NOT_FOUND: 'Tanımlı yönetici hesabı bulunamadı.',
    ADMIN_IDENTITY_MISMATCH: 'Yönetici e-postası ile hesap kimliği eşleşmiyor.',
    ADMIN_ACTIVE_SESSION_MISMATCH: 'Ana sayfadaki aktif oturum yetkili yönetici hesabıyla eşleşmiyor. Ana sayfaya yönlendiriliyorsunuz.',
    ADMIN_ACCOUNT_DISABLED: 'Yönetici hesabı devre dışı.',
    ADMIN_FIREBASE_PASSWORD_INVALID: 'Yönetici hesap şifresi doğrulanamadı.',
    ADMIN_GATE_FOUR_INVALID: 'Dördüncü güvenlik şifresi hatalı.',
    ADMIN_GATE_FIVE_INVALID: 'Beşinci güvenlik şifresi hatalı.',
    ADMIN_TOTP_INVALID: 'Google Authenticator’daki mağaza yönetici kodu hatalı veya süresi dolmuş. Yeni 6 haneli kodu girin.',
    ADMIN_TOTP_REPLAY: 'Bu tek kullanımlık kod daha önce kullanılmış. Yeni kodu bekleyin.',
    ADMIN_TOTP_NOT_CONFIGURED: 'Google Authenticator anahtarı henüz yapılandırılmamış. Render’daki ADMIN_TOTP_SECRET_BASE32 ayarını kontrol edin.',
    ADMIN_TOTP_UNAVAILABLE: 'Tek kullanımlık yönetici doğrulaması şu anda kullanılamıyor.',
    ADMIN_STAFF_IDENTITY_INVALID: 'Personel e-posta adresi veya hesap kimliği geçerli değil.',
    ADMIN_STAFF_IDENTITY_MISMATCH: 'Personelin e-posta adresi Firebase hesabındaki adresle eşleşmiyor.',
    ADMIN_STAFF_ROLE_INVALID: 'Seçilen personel rolü geçersiz veya atanamaz.',
    ADMIN_AUDIT_FAILED: 'İşlem için zorunlu güvenlik kaydı oluşturulamadı.',
    ADMIN_AUDIT_UNAVAILABLE: 'Güvenlik kayıt alanı şu anda kullanılamıyor.',
    STORE_ACCOUNT_MODERATION_FAILED: 'Hesap durumu güvenli biçimde güncellenemedi.',
    STORE_ACCOUNT_STATUS_INVALID: 'Seçilen hesap durumu geçerli değil.',
    STORE_PROMOTION_CODE_INVALID: 'Kampanya kodu 3-32 karakter olmalı; yalnızca harf, sayı, tire ve alt çizgi kullanılabilir.',
    STORE_PROMOTION_VALUE_INVALID: 'Kampanya tutarı veya yüzde oranı geçersiz.',
    STORE_PROMOTION_DATE_INVALID: 'Kampanyanın başlangıç ve bitiş tarihlerini kontrol edin.',
    STORE_PROMOTION_SCOPE_INVALID: 'Kupon kapsamındaki platform veya ürün mağaza kataloğunda bulunmuyor.',
    STORE_PROMOTION_LIMIT_INVALID: 'Toplam kullanım limiti, kuponun mevcut kullanım sayısından düşük olamaz.',
    STORE_PROMOTION_REDEMPTION_INVALID: 'Kampanya kullanım kaydı doğrulanamadığı için sipariş işlemi durduruldu.',
    STORE_LINK_LIST_INVALID: 'Bağlantı listesi geçersiz veya izin verilen 16 bağlantı sınırını aşıyor.',
    STORE_LINK_INVALID: 'Bağlantı kaydının bilgileri geçersiz.',
    STORE_LINK_ID_INVALID: 'Bağlantı kaydının güvenli kimliği doğrulanamadı.',
    STORE_LINK_PLATFORM_INVALID: 'Telegram, TikTok veya WhatsApp platformlarından birini seçin.',
    STORE_LINK_LABEL_REQUIRED: 'Bağlantı başlığı ve alt açıklaması boş bırakılamaz.',
    STORE_LINK_URL_INVALID: 'Adres, seçilen platformun resmi HTTPS alan adı ve geçerli hesap biçimiyle eşleşmelidir.',
    STORE_LINK_DUPLICATE: 'Aynı bağlantı adresi veya kimliği birden fazla kez eklenemez.',
    ADMIN_GATE_FOUR_NOT_CONFIGURED: 'Dördüncü doğrulama adımı kullanıma hazır değil.',
    ADMIN_GATE_FIVE_NOT_CONFIGURED: 'Beşinci doğrulama adımı kullanıma hazır değil.',
    ADMIN_SIGNING_SECRET_NOT_CONFIGURED: 'Güvenli yönetici oturumu kullanıma hazır değil.',
    ADMIN_HANDOFF_INVALID: 'Güvenli yönetici geçişi doğrulanamadı. Lütfen son adımı yeniden deneyin.',
    ADMIN_HANDOFF_EXPIRED: 'Yönetici geçişinin kısa süresi doldu. Son adımı yeniden doğrulayın.',
    ADMIN_HANDOFF_REPLAY: 'Bu yönetici geçişi daha önce kullanıldı. Yeni bir geçiş başlatın.',
    ADMIN_HANDOFF_ORIGIN_INVALID: 'Yönetici geçişi izin verilen mağaza alan adıyla eşleşmedi.',
    ADMIN_HANDOFF_UNAVAILABLE: 'Güvenli yönetici geçişi şu anda hazırlanamadı.',
    ADMIN_HANDOFF_REQUIRED: 'Yönetim merkezi güvenli sunucu alanında açılmalıdır. Yönetici girişinden devam edin.',
    ADMIN_SECURITY_CONFIGURATION_INCOMPLETE: payload.message || 'Yönetim güvenliği gerekli koruma düzeyinin altında.',
    ADMIN_REAUTH_REQUIRED: 'Kritik işlem için yönetici hesap şifresi gerekli.',
    ADMIN_REAUTH_INVALID: 'Yönetici hesap şifresi doğrulanamadı.',
    ADMIN_REAUTH_STALE: 'Kritik işlem doğrulamasının süresi doldu. Hesap şifrenizi yeniden doğrulayın.',
    ADMIN_REAUTH_PROVIDER_INVALID: 'Bu kritik işlem parola tabanlı yeniden doğrulama gerektirir.',
    ADMIN_REAUTH_CONFIG_MISSING: 'Kritik işlem doğrulaması kullanıma hazır değil.',
    ADMIN_REAUTH_UNAVAILABLE: 'Hesap şifresi şu anda doğrulanamıyor. Lütfen kısa bir süre sonra yeniden deneyin.',
    STORE_STORAGE_UNAVAILABLE: 'Güvenli mağaza kayıtlarına şu anda ulaşılamıyor.',
    STORE_CATALOG_PERSISTENCE_UNAVAILABLE: 'Ürün ayarlarının kalıcı kaydı doğrulanamadı. Değişiklikler uygulanmadı.',
    STORE_INDEX_REQUIRED: 'Firestore sorgu indeksi hazırlanmadı. Firebase indekslerini yayımladıktan sonra yeniden deneyin.',
    STORE_PAGE_CURSOR_INVALID: 'Sayfalama kaydı geçersiz. Listeyi yenileyip yeniden deneyin.',
    STORE_OUT_OF_STOCK: 'Siparişteki paket için yeterli stok yok. Önce stok kasasına key ekleyin.',
    STORE_INVENTORY_DUPLICATE_KEY: 'Bu key veya hesap daha önce sisteme eklenmiş. Aynı stok kaydı farklı bir üründe de tekrar kullanılamaz.',
    STORE_INVENTORY_DUPLICATE_RESERVED: 'Bu key veya hesap aktif bir sipariş için rezerve edilmiş. Sipariş bütünlüğü nedeniyle yeniden eklenemez.',
    STORE_INVENTORY_DUPLICATE_MANUAL_DELIVERY: 'Bu key veya hesap daha önce Telegram manuel teslimatında kullanılmış. Aynı teslimat bilgisinin yeniden satılmasına izin verilmez.',
    STORE_INVENTORY_KEY_INVALID: 'Key alanında boş, çok kısa veya geçersiz bir kayıt var.',
    STORE_INVENTORY_ACCOUNT_FORMAT_INVALID: 'Random hesapları her satıra “kullanıcı/e-posta | şifre” biçiminde yazın.',
    STORE_INVENTORY_IMPORT_INVALID: 'Stok listesi boş veya 200 kayıt sınırını aşıyor.',
    STORE_INVENTORY_IMPORT_CONFLICT: 'Önceki güvenli kayıt isteği farklı bir stok listesiyle eşleşiyor. Lütfen listeyi yenileyip yeniden deneyin.',
    STORE_INVENTORY_ITEM_NOT_FOUND: 'Seçilen stok kaydı bulunamadı veya başka bir havuza taşınmış.',
    STORE_INVENTORY_ITEM_REQUIRED: 'İşlem yapılacak stok kaydını seçin.',
    STORE_INVENTORY_REASON_REQUIRED: 'Bu stok işlemi için açıklayıcı bir gerekçe yazmanız gerekiyor.',
    STORE_INVENTORY_REVOKE_NOT_ALLOWED: 'Teslim edilmiş veya kullanılamayan stok kaydı iptal edilemez.',
    STORE_INVENTORY_STATUS_INVALID: 'Seçilen stok durumu geçerli değil.',
    IDEMPOTENCY_KEY_REQUIRED: 'Güvenli işlem anahtarı oluşturulamadı. Sayfayı yenileyip yeniden deneyin.',
    STORE_KEY_VAULT_UNAVAILABLE: 'Şifreli stok kasası kullanıma hazır değil. Mağaza güvenlik ayarlarını kontrol edin.',
    STORE_KEY_DECRYPTION_KEY_MISSING: 'Bu eski stok kaydı açılamadı. Mağaza sahibiyle iletişime geçin.',
    STORE_KEY_DECRYPTION_FAILED: 'Şifreli stok kaydı güvenli biçimde açılamadı.',
    STORE_INVENTORY_MIGRATION_CONFLICT: 'Ortak stok düzenlemesinde bir kayıt çakışması bulundu. Bilgilerinizin korunması için işlem güvenle durduruldu.',
    STORE_INVENTORY_INTEGRITY_ERROR: 'Stok bütünlüğü çakışması algılandı; işlem güvenli şekilde durduruldu.',
    STORE_MANUAL_DELIVERY_INVALID: 'Manuel teslimat bilgileri doğrulanamadı.',
    STORE_MANUAL_DELIVERY_COUNT_MISMATCH: 'Teslimat satırı sayısı siparişteki toplam adetle aynı olmalıdır.',
    STORE_MANUAL_DELIVERY_PAYMENT_REQUIRED: 'Teslimat bilgisi yalnızca ödeme onaylandıktan sonra bağlanabilir.',
    STORE_MANUAL_DELIVERY_ALREADY_ATTACHED: 'Bu Telegram siparişine teslimat bilgisi daha önce bağlanmış.',
    STORE_MANUAL_DELIVERY_REQUIRED: 'Siparişi teslim edildi yapmadan önce tüm ürün/adetler için manuel teslimat bilgisi ekleyin.',
    STORE_DELIVERY_INTEGRITY_ERROR: 'Teslimat bilgileri stok kaydıyla eşleşmediği için işlem durduruldu.',
    STORE_ORDER_ID_REQUIRED: 'İşlem yapılacak sipariş bulunamadı. Listeyi yenileyin.',
    STORE_ORDER_CREATE_FAILED: 'Sipariş güvenli biçimde oluşturulamadı; bakiye ve stok korunmuştur.',
    STORE_ORDER_UPDATE_FAILED: 'Sipariş durumu güncellenemedi. Lütfen kaydı yenileyip yeniden deneyin.',
    STORE_ORDER_TRANSITION_INVALID: 'Siparişin mevcut durumu seçilen geçişe izin vermiyor.',
    STORE_ACCOUNT_NOT_FOUND: 'Tam eşleşen kullanıcı bulunamadı.',
    STORE_USER_IDENTIFIER_AMBIGUOUS: 'Bu kullanıcı adı birden fazla kayıtla eşleşti. E-posta veya UID kullanın.',
    STORE_BALANCE_WOULD_BE_NEGATIVE: 'Bu işlem kullanıcı bakiyesini sıfırın altına düşürür.',
    STORE_BALANCE_TYPE_AMOUNT_MISMATCH: 'Hareket türü ile tutarın yönü eşleşmiyor.',
    STORE_BALANCE_ADJUSTMENT_INVALID: 'Bakiye tutarı geçersiz veya işlem limitini aşıyor.',
    STORE_BALANCE_TYPE_INVALID: 'Bakiye hareket türü desteklenmiyor.',
    STORE_BALANCE_REASON_REQUIRED: 'Bakiye işlemi için en az 3 karakterlik gerekçe zorunludur.',
    STORE_BALANCE_LIMIT_EXCEEDED: 'Bu işlem hesap bakiye üst sınırını aşar.',
    STORE_BALANCE_ADJUSTMENT_CONFLICT: 'Aynı güvenli işlem anahtarı farklı bakiye bilgileriyle tekrar kullanılamaz.',
    STORE_BALANCE_ADJUSTMENT_FAILED: 'Bakiye hareketi tamamlanamadı. İşlem güvenli şekilde geri alındı.',
    STORE_ACCOUNT_DISABLED: 'Hedef kullanıcı hesabı devre dışı olduğu için bakiye işlemi yapılamaz.',
    STORE_TARGET_UID_REQUIRED: 'Hedef kullanıcı UID bilgisi bulunamadı.',
    STORE_USER_IDENTIFIER_REQUIRED: 'Kullanıcı aramak için e-posta, UID veya kullanıcı adı yazın.',
    APP_CHECK_REQUIRED: 'Güvenli istek doğrulaması gerekli. Sayfayı yenileyin.',
    APP_CHECK_INVALID: 'Güvenli istek doğrulaması geçersiz veya süresi dolmuş.',
    STORE_TELEGRAM_ONLY_PRODUCT: 'Bu ürün yalnızca Telegram üzerinden sipariş edilebilir; otomatik teslimat ve bakiye ile otomatik satın alma kullanılamaz.',
    STORE_PRODUCT_FULFILLMENT_REQUIRED: 'Satışta olan bir üründe otomatik teslimat veya Telegram satış kanallarından en az biri açık olmalıdır.',
    STORE_PRODUCT_PRICE_INVALID: 'Paket fiyatı geçersiz. Fiyat sıfırdan büyük ve desteklenen sınırlar içinde olmalıdır.',
    STORE_PRODUCT_SETTINGS_INVALID: 'Ürün alanlarının türü veya paket biçimi geçersiz. Formu yenileyip tekrar deneyin.',
    STORE_CONTENT_INVALID: 'Mağaza içerik alanları doğrulanamadı. Formu yenileyip tekrar deneyin.',
    STORE_PRODUCT_NOT_FOUND: 'Ürün bulunamadı. Güncel ürün listesini yeniden yükleyin.',
    STORE_SKU_INVALID: 'Ürün veya paket kimliği geçersiz.',
    STORE_PRODUCT_SORT_INVALID: 'Ürün sıralaması 0-10000 arasında tam sayı olmalıdır.',
    STORE_PRODUCT_PLATFORM_INVALID: 'Ürün platformu yalnızca Android veya iOS olabilir.',
    STORE_PRODUCT_IMAGE_INVALID: 'Ürün görseli yalnızca güvenli /public/assets/products/ yolundan seçilebilir.',
    STORE_PRODUCT_BULK_INVALID: 'Toplu kayıt listesi boş veya izin verilen ürün sınırını aşıyor.',
    STORE_PRODUCT_BULK_DUPLICATE: 'Aynı ürün toplu kayıt isteğinde birden fazla kez gönderilemez.',
    STORE_AUTOMATIC_INVENTORY_DISABLED: 'Bu ürün için otomatik stok kasası kapalıdır; teslimat yalnızca Telegram üzerinden yönetilir.',
    ADMIN_OWNER_REQUIRED: 'Bu bölüm yalnızca korunan mağaza sahibi hesabı tarafından yönetilebilir.',
    AUTH_REQUIRED: 'Lütfen yönetici oturumunuzu yeniden doğrulayın.',
    AUTH_UNAVAILABLE: 'Hesap doğrulaması şu anda kullanıma hazır değil.',
    ORIGIN_NOT_ALLOWED: 'Bu alan adından yönetim isteğine güvenlik nedeniyle izin verilmedi.',
    TOO_MANY_REQUESTS: 'Çok fazla deneme yapıldı. Lütfen kısa bir süre sonra yeniden deneyin.',
    RATE_LIMIT_STORE_UNAVAILABLE: 'Dağıtık güvenlik kontrolü şu anda kullanılamıyor. İşlem uygulanmadı.',
    ID_TOKEN_REQUIRED: 'Yönetici hesap oturumu doğrulanamadı. Lütfen yeniden giriş yapın.',
    SESSION_REVOCATION_FAILED: 'Yönetici oturumu güvenli biçimde sonlandırılamadı.',
    ADMIN_SESSION_REVOCATION_FAILED: 'Yönetici erişim oturumu güvenli biçimde iptal edilemedi.',
    INVALID_JSON: 'Gönderilen bilgiler okunamadı. Lütfen alanları kontrol edip yeniden deneyin.',
    REQUEST_BODY_TOO_LARGE: 'Gönderilen bilgi boyutu izin verilen sınırı aşıyor.'
  };
  return messages[code] || (status >= 500 ? 'İşlem şu anda tamamlanamadı. Lütfen yeniden deneyin.' : 'İşlem doğrulanamadı.');
}

export async function adminFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(60_000, Math.max(1500, Number(options.timeoutMs) || 20_000)));
  try {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    headers.set('X-Shelby-Store-Client', 'secure-admin-v66');
    const url = window.SHELBY_ADMIN_AUTH?.apiUrl?.(path) || path;
    const method = String(options.method || (options.body === undefined ? 'GET' : 'POST')).toUpperCase();
    let sameOrigin = false;
    try { sameOrigin = new URL(url, window.location.href).origin === window.location.origin; } catch (_) {}
    if (!sameOrigin || method !== 'GET') {
      const token = await waitForSignal(Promise.resolve().then(() => window.SHELBY_ADMIN_AUTH?.token?.()).catch(() => ''), controller.signal);
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    const appCheckToken = await waitForSignal(Promise.resolve().then(() => window.SHELBY_ADMIN_AUTH?.appCheckToken?.()).catch(() => ''), controller.signal);
    if (appCheckToken) headers.set('X-Firebase-AppCheck', appCheckToken);
    let body = options.body;
    if (body && typeof body !== 'string') {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    } else if (typeof body === 'string') {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(url, { ...options, method, headers, body, credentials: 'include', cache: 'no-store', signal: controller.signal });
    const payload = await readApiJson(response);
    if (!response.ok || payload.ok === false) {
      const error = new Error(errorMessage(payload, response.status));
      error.code = payload.error || payload.code || `HTTP_${response.status}`;
      error.status = response.status;
      error.payload = payload;
      error.requestId = String(payload.requestId || response.headers.get('x-request-id') || '');
      if ([401, 403].includes(response.status) && ['AUTH_REQUIRED', 'AUTH_INVALID', 'ADMIN_REQUIRED', 'ADMIN_GATE_REQUIRED', 'ADMIN_GATE_ACCESS_INVALID', 'ADMIN_ACTIVE_SESSION_MISMATCH'].includes(String(error.code))) {
        window.dispatchEvent(new CustomEvent('shelby:admin-session-invalid', { detail: { code: error.code } }));
      }
      throw error;
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      const timeout = new Error('Yanıt zamanında alınamadı. Tekrar işlem yapmadan önce güncel kaydı kontrol edin.');
      timeout.code = 'REQUEST_TIMEOUT';
      throw timeout;
    }
    if (error instanceof TypeError) {
      const network = new Error('Yönetim ekranına ulaşılamadı. Bağlantınızı kontrol edip yeniden deneyin.');
      network.code = 'NETWORK_ERROR';
      throw network;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
