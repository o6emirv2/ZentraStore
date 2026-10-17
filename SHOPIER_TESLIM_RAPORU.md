# WEQ / ZENTRA STORE — Shopier teslim raporu

Sürüm **80.0.0**. Temel: son teslim edilen **ZENTRA-STORE-YATAY-KATEGORILER.zip**. Tarih: **17.10.2026 UTC**.

Kaynak entegrasyonu ve izole doğrulamalar hazırdır. **Canlı deploy, PAT/abonelik kurulumu, gerçek tahsilat veya iade yapılmadı. `SHOPIER_ENABLED=false` teslim edilir.** Canlı kabul kontrolü yapılmadan entegrasyonun canlıda tamamen çalıştığı iddia edilmez.

## A. Güncellenen dosyalar

Backend Express/CommonJS, frontend vanilla ES modülleri, veritabanı Firebase Admin/Firestore olarak korundu. JSON katalog + Firestore ürün ayarları, indirim, şifreli stok/teslimat, mevcut hesap/admin izinleri incelendi. Mevcut sipariş koleksiyonu genişletildi; pending için eski şemanın `awaiting_payment` durumu ve yeni `paymentState=pending` birlikte kullanıldı.

Kaynakta **45 dosya** güncellendi. Bunlardan **21 tanesi yalnızca önbellek/import sürümü** değişikliğidir. Ayrı Android/iOS kategori şeması, 34 ürünün fiyat/paket JSON'u, Firestore erişim kuralları ve CNAME dosyası temel ZIP ile **bayt düzeyinde aynı** kaldı. Yatay kaydırma kodu korundu; kategori CSS'sine yalnızca yeni ödeme stilleri eklendi.

| Dosya | İşlem |
|---|---|
| `admin/admin-core.js` | Güvenli ve anlaşılır Shopier hata mesajları. |
| `admin/admin-dashboard.css` | Shopier işlem kartları ve mobil uyumlu kuyruk alanı. |
| `admin/admin-dashboard.js` | Shopier metaverisi, arama/filtre, kontrollü doğrulama/kapatma/teslimat ve hata kuyruğunu yeniden deneme. |
| `admin/admin-entry.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `admin/admin-gate.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `admin/admin.html` | Ödeme yöntemi filtresi, Shopier bağlantı/ENV/kuyruk durum alanları ve arama açıklaması. |
| `admin/index.html` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `admin/promo-codes.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `admin/session/handoff/index.html` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `firestore.indexes.json` | Mevcut indekslere dokunmadan uid + shopierOpen sorgu indeksi eklendi. |
| `index.html` | Sepete Shopier seçeneği, düğme ve erişilebilir işlem durumu eklendi; mevcut düğmeler korundu. |
| `package-lock.json` | Sürüm ve geliştirme bağımlılığı için tekrarlanabilir kilit kaydı. |
| `package.json` | 80.0.0, Shopier test/setup komutları, yeni modüllerin denetimi; yalnızca UI testi için playwright-core geliştirme bağımlılığı. |
| `public/css/storefront-design.css` | Mevcut kategori kaydırmasını değiştirmeden Shopier düğme/durum stilleri. |
| `public/js/store/api.js` | Ödeme uçlarına özel Bearer, sürüm uyumu ve güvenli hata mesajları. |
| `public/js/store/auth.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `public/js/store/customer-app.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `public/js/store/customer-renderers.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `public/js/store/order-view.js` | Shopier ödeme etiketi ve kendi siparişine ait durum takip bağlantısı. |
| `public/js/store/product-detail.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `public/js/store/product-gallery.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `public/js/store/product-media.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `public/js/store/products.js` | Backend Shopier kullanılabilirlik bayrağının güvenli katalog normalizasyonu. |
| `public/js/store/showcase-slider.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `public/js/store/storefront.js` | Oturuma bağlı Shopier başlatma/kurtarma, stok/kapalı kanal kontrolleri ve güvenli yönlendirme. |
| `public/js/ui/app-ui.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `public/js/ui/interaction-guard-entry.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `public/js/ui/list-controls.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `public/js/ui/notification-center.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `render.yaml` | Mevcut servis/ENV değerleri korunarak kapalı Shopier ayarları ve üç gizli alan eklendi. |
| `script.js` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `scripts/admin-client-regression.cjs` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `scripts/build-pages.cjs` | İki ödeme sayfasının statik frontend paketine alınması. |
| `scripts/catalog-filter-regression.cjs` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `scripts/experience-regression.cjs` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `scripts/helpers/application-fixture.cjs` | Yalnızca testte üretilen Shopier ayarlarıyla izole HTTP uygulama kurulumu. |
| `scripts/http-regression.cjs` | Yalnızca zentra-ui-v80 önbellek/import sürümü yenilendi; davranış değiştirilmedi. |
| `scripts/verify-source.cjs` | Yeni ödeme sayfalarının standart viewport kontrolü; eski sayfaların 0.80 kuralı korundu. |
| `server.js` | Sadece webhook için ham gövde yolu; normal ödeme routerı, worker yaşam döngüsü ve gerçek sonuç sayfası yolları. |
| `server/core/adminActionService.js` | Shopier yönetici eylemleri ve kuyruk tekrarına izin/tek kullanımlık işlem onayı kapsamı. |
| `server/core/apiContracts.js` | Yeni isteklerin sıkı gövde şeması ve eski istemci yazma koruması. |
| `server/core/runtimeHealth.js` | Yeni ödeme ve yönetici yollarına mevcut kimlik/kasa yapılandırma koruması. |
| `server/core/storeInventoryService.js` | Mevcut tahsisi koruyan rezervasyon/rezervasyondan teslimat ve doğrulanmış rezervasyon bırakma. |
| `server/core/storeService.js` | Ortak sipariş görünümünde Shopier, paidAt/iade bilgileri; yerel keyfi ödeme onayı engeli; eski ödeme akışları korundu. |
| `server/routes/store.routes.js` | Admin doğrulama/kapatma/kuyruk uçları; mevcut yetki, parola, rate limit ve audit zinciri. |

ZIP kökündeki `DEGISIKLIK-RAPORU.txt`, önceki kategori sürümünün raporu yerine bu teslimin güncel özetini gösterir. Uygulama dosyası değildir.

## B. Eklenen dosyalar

Kaynağa **23 dosya** eklendi:

| Dosya | Görevi |
|---|---|
| `.env.example` | Gizli bilgi içermeyen yeni ayar örneği. |
| `.gitignore` | Özel ENV, token setup dosyası, bağımlılık ve geçici test çıktılarını Git dışında tutar. |
| `README.md` | Mimari, kurulum, test komutları, desteklenen akış ve işletim koşulları. |
| `RENDER_ENV_KURULUM.txt` | Tüm yeni ENV değerleri, gizlilik/zorunluluk, gerçek adresler ve adım adım Render/Shopier kurulumu. |
| `SHOPIER_TESLIM_RAPORU.md` | Bu tam dosya/değişiklik/güvenlik/ENV/test/risk teslim raporu. |
| `TEST_SONUCLARI.json` | Çalıştırılmış testlerin makine tarafından okunabilir sayıları, adları ve kapsam sınırları. |
| `odeme/iptal/index.html` | Tahsilat iptal etmeden gerçek ödeme durumunu okuyan sayfa. |
| `odeme/sonuc/index.html` | Gerçek ödeme takip sayfası. |
| `public/css/shopier-result.css` | Mobil ve masaüstüne uyumlu ödeme takip görünümü. |
| `public/js/store/shopier-checkout.js` | Kalıcı idempotency gövdesi/anahtarı, kontrollü yeniden deneme ve doğrulanmış yönlendirme. |
| `public/js/store/shopier-result.js` | Kullanıcının kendi siparişini API üzerinden takip etmesi; URL başarı iddiasına güvenmez. |
| `scripts/helpers/browser-firebase.cjs` | UI testinde dış Firebase SDK sınırını taklit eder. |
| `scripts/helpers/shopier-fixture.cjs` | Resmî REST ürün/order/refund ve webhook biçimine göre izole sağlayıcı sınırı. |
| `scripts/shopier-browser.cjs` | Gerçek Chromium üzerinde 5 izole mobil/masaüstü/admin/kategori/kapalı kanal grubu. |
| `scripts/shopier-client-regression.cjs` | 7 tarayıcı modülü testinde kurtarma/depolama/yönlendirme denetimi. |
| `scripts/shopier-regression.cjs` | 57 backend/HTTP/kripto/iş kuralı ve güvenlik testi. |
| `scripts/shopier-webhooks.cjs` | Operatör abonelik kontrol/kayıt aracı; token konsola basılmaz, özel 0600 dosyaya kaydedilir. |
| `server/config/shopier.js` | Kapalı varsayılan, sıkı ENV/HTTPS/host/anahtar/zaman aşımı doğrulaması. |
| `server/core/shopierClient.js` | Yalnızca backend PAT REST istemcisi, sınırlı JSON, timeout ve doğrulanmış Shopier URL/tutar yardımcıları. |
| `server/core/shopierJobs.js` | Firestore lease, retry/backoff, hata kuyruğu, güvenli admin tekrar denemesi ve worker. |
| `server/core/shopierService.js` | Sunucu fiyatı, promosyon ve stok rezervasyonu; tek seferlik ürün bağlantısı; API uzlaştırma, paid/iade ve atomik teslimat. |
| `server/core/shopierWebhooks.js` | Resmî kaynak gövdesi + Shopier-Event; ham gövde HMAC-SHA256 hex doğrulaması ve kalıcı tekrar koruması. |
| `server/routes/shopier.routes.js` | Auth ödeme başlatma/durum/kurtarma uçları ve ayrı güvenli webhook alıcısı. |

Yeni koleksiyonlar: `shopierCheckoutAttempts`, `shopierProducts`, `shopierPayments`, `shopierWebhookReceipts`, `shopierJobs`. Bunlar yalnızca uygulama işlemi gerçekleştiğinde oluşturulur. Gerçek veritabanında bu çalışma sırasında değişiklik yapılmadı.

Yeni yollar: `POST /api/payments/shopier/create`, `POST /api/payments/shopier/webhook`, `GET /api/payments/shopier/attempt`, `GET /api/payments/shopier/orders/:id`; admin tarafında Shopier durum, uzlaştırma, bağlantı kapatma ve başarısız iş tekrar uçları. Frontend'de `/odeme/sonuc` ve `/odeme/iptal` oluşturuldu.

## C. Silinen dosyalar

**Hiçbir mevcut uygulama kaynak dosyası silinmedi.** Eski sürümün kök teslim raporu güncel teslim özetiyle yenilendi. `node_modules`, üretilmiş `dist-pages`, özel ENV/token dosyaları, geçici loglar, ekran görüntüleri ve çalışma araçları ZIP'e eklenmedi. Çalışma için gereken kaynaklar, lisanslar ve bağımlılık kilidi korundu; bağımlılıklar `npm ci` ile kurulur.

## D. Güvenlik ve veri bütünlüğü

- Ürün, paket, fiyat, indirim, hesap durumu ve stok backend'de doğrulanır. İstemci toplamı/ek fiyat alanları kabul edilmez; beklenen fiyat değişmişse işlem reddedilir. Firestore katalog revizyonu transaction içinde kontrol edilir.
- Ödeme bekleyen stok şifreli kasada ayrılır; ödeme doğrulanmadan teslimat öğesi üretilmez. Kullanıcı başına iki açık rezervasyon sınırı ve mevcut sıkı ödeme rate limit'i vardır.
- Aynı sipariş anahtarı ve istek özeti tek siparişe bağlıdır. Tarayıcı kaybolan yanıtı önce okur. Sonucu belirsiz, idempotency desteği belgelenmeyen ürün POST'u otomatik tekrarlanmaz; resmî ürün listeleme API'siyle aranır.
- Ham JSON, parse edilmeden HMAC-SHA256 hex ile doğrulanır; `timingSafeEqual` kullanılır. `Shopier-Event` başlığı ve kaynak gövdesi, resmî Node örneğindeki biçimdedir. Olay türleri ayrı abonelik anahtarıyla sınırlandırılır. IP veya imzalanmamış olay/hesap başlığı tek başına kanıt sayılmaz.
- Webhook özeti/olay/ID kalıcı kaydedilir. Ham müşteri gövdesi, PAT ve imza token'ları DB'ye veya loga yazılmaz. 3.5 saniyelik depolama yanıt sınırı bulunur; depo başarısızsa 200 verilmez. Sağlayıcı API sorgusu ve teslimat worker'da yapılır.
- Worker, PAT ile kendi hesaptaki gerçek order/refund kaydını okur. Ürün eşlemesi, benzersiz Shopier order ID, TRY tutarı, miktar, paket manifesti ve e-posta doğrulanır. `fulfilled` teslimat durumu ödeme kanıtı değildir; `paymentStatus=paid` gerekir.
- Paid kaydı ile teslimat işi aynı transaction'a yazılır. Ayrılmış stoktan order/stok/teslimat/audit birlikte değişir. Tekrarlanan webhook veya paralel teslimat ikinci kez key üretmez. Tam iade eski snapshot ile tekrar paid olamaz.
- Orijinal Bearer/oturum, SameSite/Origin/CSRF, App Check politikası, admin izinleri, yeniden parola doğrulaması ve gövdeye bağlı tek kullanımlık admin işlem onayı korundu. Webhook istisnası yalnızca ilgili alıcı yolundadır.
- API origin sabittir; PAT başka host'a gönderilmez. Yönlendirmeler sadece HTTPS Shopier host'larına yapılır; API redirect takibi kapalıdır. Yanıt boyutu/JSON/para biçimi, giriş şemaları ve timeout kontrol edilir. Sağlayıcı hata gövdeleri müşteriye/loglara aktarılmaz.
- Admin paid/refunded durumunu menüden keyfi uygulayamaz. İade Shopier'de gerçekleştirilir ve doğrulanır. Doğrulanmış siparişler mevcut şifreli teslimat ekranında açılır.

## E. Render ENV ve gerçek bağlantılar

Hedef: **Render → emirhan-siye Web Service → Environment**. Mevcut değişkenleri silmeyin. Ayrıntılı zorunluluk ve URL belirleme açıklaması `RENDER_ENV_KURULUM.txt` içindedir.

| Anahtar | Değer / güvenli yer tutucu | Amaç | Gizli | Zorunluluk / değer kaynağı |
|---|---|---|---|---|
| `SHOPIER_ENABLED` | `false` | Yeni ödeme açma anahtarı | Hayır | Varsayılan kapalı; kontrollü kabul sonrası açılır |
| `SHOPIER_PAT` | `<YENI_GIZLI_PAT>` | Backend Bearer erişimi | Evet | Zorunlu; kendi Shopier hesabında yeni üretilir, eski ifşa edilen PAT iptal edilir |
| `SHOPIER_API_BASE_URL` | `https://api.shopier.com/v1` | Resmî REST v1 | Hayır | Varsayılanıyla isteğe bağlı; başka host kabul edilmez |
| `SHOPIER_WEBHOOK_TOKEN` | `<ORDER_CREATED_TOKEN>` | Ödeme bildirimi HMAC | Evet | Zorunlu; order.created aboneliğinin ilk yanıtı |
| `SHOPIER_REFUND_WEBHOOK_TOKEN` | `<REFUND_UPDATED_AYRI_TOKEN>` | İade bildirimi HMAC | Evet | Zorunlu; refund.updated aboneliğinin ilk yanıtı |
| `SHOPIER_WEBHOOK_URL` | `https://emirhan-siye.onrender.com/api/payments/shopier/webhook` | Sunucu bildirimi | Hayır | Zorunlu; render.yaml ve mevcut backend origin + yeni route |
| `WEQ_PUBLIC_BASE_URL` | `https://zentrastore.com.tr` | Site/ürün PNG origin'i | Hayır | PUBLIC_BASE_URL varsayılanıyla isteğe bağlı; gerçek site ile aynı origin |
| `SHOPIER_SUCCESS_URL` | `https://zentrastore.com.tr/odeme/sonuc` | WEQ takip sayfası | Hayır | Türetilen varsayılanıyla isteğe bağlı; ZIP'te gerçek sayfa |
| `SHOPIER_CANCEL_URL` | `https://zentrastore.com.tr/odeme/iptal` | WEQ durum kontrol sayfası | Hayır | Türetilen varsayılanıyla isteğe bağlı; ZIP'te gerçek sayfa |
| `SHOPIER_HTTP_TIMEOUT_MS` | `15000` | API/yanıt timeout | Hayır | Varsayılanıyla isteğe bağlı; 1000–20000 ms |

Bütün ENV'ler backend servisine eklenir; frontend'e gizli bilgi konmaz. Success/cancel URL'leri WEQ uygulama ayarlarıdır; ürün oluşturma API'sine desteklenmeyen yönlendirme parametreleri olarak gönderilmez. Otomatik Shopier dönüşü garanti edilmez; müşteri Siparişlerim'den takibi açar.

Mevcut `https://zentrastore.com.tr`, backend `https://emirhan-siye.onrender.com/api/healthz` ve PNG medya adresi 17.10.2026'da HTTPS/TLS doğrulamasıyla 200 verdi. **Yeni endpoint ve sayfalar henüz canlıya dağıtılmadı; canlıda erişilebilir oldukları doğrulanmış değildir.** Render hesabının bölgesi veya sabit IP'si görülmedi; tahmini IP kullanılmadı. Gerekirse gerçek çıkış aralıkları Render Connect → Outbound ekranından alınır.

## F. Çalıştırılan testler

- `npm run build`: **302 geçti, 0 başarısız, 0 atlandı**. 238 mevcut regresyon + 57 yeni backend/HTTP testi + 7 yeni frontend modül testi.
- Gerçek Chromium'da izole `npm run test:shopier:browser`: **5 grup geçti, 0 başarısız**, JavaScript sayfa hatası 0. 1440px masaüstü ve 390px mobil; ödeme başlatma/yönlendirme, pending→paid→delivered, sahte başarı URL'si, iptal sayfası, admin arama/filtre, yatay dokunma ve ayrı iOS/Android kategorileri kontrol edildi.
- Kaynak kontrolü: **129 JS sözdizimi dosyası, 15 CSS dosyası, 6 HTML sayfası, 34 ürün** doğrulandı. Yerel asset/import ve DOM referansları kontrol edildi.
- `npm audit --omit=dev --audit-level=moderate`: **0 güvenlik açığı**. Bu sonuç tarama tarihindeki bilinen bağımlılık kayıtları içindir.
- `node scripts/build-pages.cjs`: sonuç/iptal sayfaları statik çıktıya alındı; backend çıktı dışında kaldı.
- Temiz kopyada bağımlılıklar `npm ci --no-fund` ile kuruldu: **247 paket**. Temiz kopya build ve Chromium test sonuçları `TEST_SONUCLARI.json` içinde ayrıca kaydedilir.

Kullanıcının 25 senaryosunun eşlemesi:

| No | Senaryo | Çalıştırılan kontrol |
|---|---|---|
| 1 | Ödeme başlatma | Backend 01 + mobil/masaüstü UI |
| 2 | Ürün/paket | Backend 02, 42 |
| 3 | Yanlış fiyat | Backend 03, 04 |
| 4 | Geçersiz ürün | Backend 05 |
| 5 | Geçersiz paket | Backend 06 |
| 6 | Başarılı bildirim | Backend 07 + gerçek UI üzerinde mock callback |
| 7 | Başarısız ödeme | Backend 08; desteklenmeyen failed durumu 25'te reddedildi |
| 8 | İptal | Backend 09, 38, 39; kontrol sayfası tahsilat iptal etmez |
| 9 | Bekleyen ödeme | Backend 10, 49 |
| 10 | Sahte webhook | Backend 11 |
| 11 | Geçersiz imza | Backend 12, 26, 47, 48 |
| 12 | Tekrarlanan bildirim | Backend 13 |
| 13 | Yanlış sipariş | Backend 14, 28 |
| 14 | Yanlış tutar | Backend 15 |
| 15 | Yanlış para birimi | Backend 16 |
| 16 | Timeout | Backend 17 |
| 17 | Bağlantı kesintisi | Backend 18, 50 |
| 18 | Eş zamanlı ödeme | Backend 19, 20 |
| 19 | İkinci teslimat | Backend 21, 13 |
| 20 | Başarılı ödeme kaydı | Backend 07, 22 |
| 21 | Admin görünümü | Backend 22, 36, 54, 56 + admin UI |
| 22 | Eski ödeme yöntemleri | Backend 23 + mevcut 238 regresyon |
| 23 | Mobil akış | Chromium mobile grubu |
| 24 | Masaüstü akış | Chromium desktop grubu |
| 25 | ENV eksik/hatalı | Backend 24, 55 + disabled UI |

Resmî order modeli `paymentStatus=paid/unpaid` sunar; gerçekte olmayan failed/cancelled ödeme eventi icat edilmedi. Gerçek kart reddi/3DS, banka işlemi ve sağlayıcının canlı oturum davranışı bu testlerin yerine geçmez. Mock Firestore transaction fixture'ı okuma-yazma sırasını, iptalde geri almayı ve seri commit'i denetler; gerçek Firestore IAM/ağ ortamı bu çalışmada sınanmadı.

## G. Kalan canlı kurulum ve sınırlar

1. Yeni PAT ve iki gerçek webhook aboneliği/token'ı operatörce kurulmalı, eski sızan PAT iptal edilmelidir. Gerçek anahtar verilmedi ve istenmedi; mevcut Render/Shopier paneline erişim kullanılmadı.
2. Backend ve frontend aynı sürümden dağıtılmalı; yeni Firestore indeksi hazır olmalı; yeni public webhook/sonuç sayfası URL'leri canlıda kontrol edilmelidir. Gerçek imzalı callback'in 5 saniye sınırı ve gerçek hesap ürün oluşturma izinleri doğrulanmalıdır.
3. Shopier ürün API'siyle sepet için tek dijital özel ürün oluşturulur. Hesabın izinleri, görünürlük/medya, otomatik indirim, ödeme e-postası ve gerçek TRY toplamının bu akışla uyumu canlı kabul testinde doğrulanmalıdır. Müşterinin ödeme e-postası farklıysa otomatik teslimat açılmaz.
4. Canlı tahsilat/iade yapılmadı. Kontrollü canlı kabul testi ayrıca açık onay gerektirir. Sandbox erişimi doğrulanmadı. `SHOPIER_ENABLED=false`, kabul doğrulaması tamamlanmadan genel müşteriye açılmamalıdır.
5. Terk edilen açık rezervasyonlar admin tarafından izlenir; otomatik süre doldu varsayımıyla bırakılmaz. Bağlantı kapatma kart iadesi değildir. Geç tahsilat paid + inceleme olur; başka müşterinin key'i teslim edilmez.
6. Sonucu belirsiz ürün oluşturma beş sayfalık resmî ürün taramasında tek eşleşmeyle kurtarılır. Eşleşme yoksa/çiftse veya 250'den fazla yeni ürün varsa operatör incelemesi gerekir; yeni POST körlemesine tekrarlanmaz.
7. Üretimde uyumayan servis ve izlenen hata kuyruğu gerekir. Kesinti/cold-start doğrulamayı geciktirebilir. Render planı veya dedicated IP satın alınmadı/değiştirilmedi.
8. Kısmi/bekleyen iade otomatik teslimatı durdurur. Teslim edilmiş key'in gerçek sağlayıcıda iptali için bir API bulunmadığı için bu işlem yapılmış gibi gösterilmez; mevcut politika ve admin işlemi uygulanır.
9. Geçersiz tutar/ürün/müşteri eşleşmesi paid yapılmaz; hata kuyruğu/admin uzlaştırması gerekir. Admin arama ve ödeme yöntemi filtresi yüklenen sayfalara uygulanır. Idempotency/ödeme kayıtları replay koruması için korunmalıdır.

## H. Teslim paketi

**ZENTRA-STORE-SHOPIER-ENTEGRE-GUNCEL.zip**; tam frontend/backend, mevcut asset/lisanslar, yeni ödeme/webhook/teslimat/admin modülleri, testler, `.env.example`, `render.yaml`, ENV kurulumu ve bu raporu içerir. `npm ci` ile temiz kurulum doğrulanır; üretilmiş bağımlılıklar/geçici çıktılar pakete konmaz. ZIP CRC ve bütün dosyaların hash eşleşmesi teslimden önce kontrol edilir.

Resmî kaynaklar: [PAT](https://developer.shopier.com/docs/creating-and-using-pats), [ürün oluşturma](https://developer.shopier.com/reference/post-products), [ürün modeli](https://developer.shopier.com/reference/the-product-model), [order modeli](https://developer.shopier.com/reference/the-order-model), [abonelik oluşturma](https://developer.shopier.com/reference/post-webhooks), [abonelik modeli](https://developer.shopier.com/reference/the-webhook-model), [webhook kuralları](https://developer.shopier.com/reference/webhook-configuration), [resmî Node webhook örneği](https://developer.shopier.com/recipes/webhook-handler-nodejs-1), [Render çıkış IP'leri](https://render.com/docs/outbound-ip-addresses). Resmî belge HTML'lerine gömülü OpenAPI şeması ve Node örneğinin veri kaynağı incelendi; üçüncü taraf eski Shopier kodu kullanılmadı.
