# WEQ / ZENTRA STORE — Shopier entegrasyonu

Sürüm **80.0.0**, son `ZENTRA-STORE-YATAY-KATEGORILER.zip` kaynakları üzerine hazırlanmıştır. Shopier canlıya açılmadan teslim edilir. Kurulumun tamamı [RENDER_ENV_KURULUM.txt](RENDER_ENV_KURULUM.txt) içindedir; gerçek anahtarlar pakette bulunmaz.

## Çalıştırma ve doğrulama

Node 24 ve npm 10/11 kullanın. Mevcut Firebase, admin ve stok kasası ENV'lerini koruyun. Shopier ayarları `.env.example` dosyasında yalnızca yer tutucudur; Render gerçek ENV değerlerini kendisi sağlar. Yerel `.env` dosyası otomatik yüklenmez; gerekiyorsa Node'un `--env-file` seçeneğini kullanın ve dosyayı paylaşmayın.

```sh
npm ci
npm run build
npm start
```

`npm run build`, kaynak/HTML/CSS/katalog kontrollerini ve tüm Node regresyon testlerini çalıştırır. Üretim kurulumu mevcut `npm ci --omit=dev --no-fund && npm run build` komutuyla çalışır. `playwright-core` yalnızca ayrı tarayıcı testinin geliştirme bağımlılığıdır.

```sh
npm run test:shopier
npm run test:shopier:browser
npm audit --omit=dev --audit-level=moderate
npm run build:pages
```

Tarayıcı testi için `npm ci` ile geliştirme bağımlılıklarını kurun. Makinede Chrome varsa test `channel: chrome` kullanır; başka Chromium için `CHROMIUM_EXECUTABLE_PATH` verin. Ek kütüphaneler gereken Linux kurulumlarında yalnızca test sürecine `CHROMIUM_LIBRARY_PATH` verilebilir. Bu test ayarları Render ödeme ENV'leri değildir. `test-results/shopier` çıktıları teslim paketine/yayına eklenmez. Test gerçek Firebase/Shopier sınırlarını taklit eder; Express API, kimlik doğrulama, iş kuralları, şifreli stok ve kuyruk işlemleri gerçek proje kodudur.

Statik frontend ayrı hosting'deyse yalnızca `dist-pages` içeriğini yayınlayın. Tüm kaynak klasörünü, backend'i veya özel ENV dosyalarını statik hosting'e yüklemeyin. `odeme/sonuc` ve `odeme/iptal` dizinleri build'e dahildir.

## Uygulanan ödeme akışı

1. Auth + Origin/App Check politikasından geçen `POST /api/payments/shopier/create`, ürün/paket/fiyat/indirim/stoğu sunucuda kontrol eder.
2. Var olan `storeOrders` koleksiyonunda `awaiting_payment` ve `paymentState=pending` kaydı oluşur. Bu, mevcut durum şemasını koruyan pending karşılığıdır. Stok şifreli kasada ayrılır; teslimat kaydı üretilmez.
3. Resmî `POST /v1/products`, siparişe özel **tek stoklu, digital, customListing** bir sepet ürünü oluşturur. Yerel ürün/paket/adet manifesti siparişe sabitlenir. Yanıttaki doğrulanmış Shopier ürün URL'si müşteriye verilir. Desteklenmeyen checkout/session, success/cancel/callback parametreleri veya eski form imzası kullanılmaz.
4. `Shopier-Event` başlığı ve kaynak nesnesi biçimindeki ham JSON alınır. `Shopier-Signature` HMAC-SHA256 hex imzası zaman sabitli karşılaştırılır. Her olay türü ayrı abonelik token'ıyla sınırlandırılır. Geçerli olay ve gövde özeti Firestore'a yazılıp 200 dönülür.
5. Kalıcı kuyruk, PAT ile `GET /orders/{id}` yapar. Kendi Shopier hesabındaki ürün eşlemesi, benzersiz sağlayıcı siparişi, TRY tutarı, tek sepet ürünü/adedi, paket manifesti ve müşteri e-postası eşleşmeden paid olmaz.
6. Paid kaydı ve teslimat işi atomik yazılır. Ayrılan stoktan mevcut şifreli teslimat sistemi kullanılır; order + stok + teslimat + audit tek transaction içinde değişir. Tekrarlanan olay veya teslimat girişimi ikinci teslimat yapmaz.

Sipariş başlatma anahtarı önce tarayıcı oturumunda saklanır. Yanıt kaybolursa önce `GET /api/payments/shopier/attempt` ile kontrol edilir. Açık yeniden deneme aynı gövde/anahtarı kullanır. Sonucu belirsiz ürün oluşturma POST'u backend'de yeniden gönderilmez; ürünler resmî listeleme API'sinden siparişe özgü başlık/manifest ile aranır. Bulunamazsa yönetici incelemesi gerekir.

Mağaza hesabı ile Shopier ödeme e-postasının aynı olması otomatik teslimat koşuludur. Farklı e-posta, beklenmeyen Shopier indirimi veya tutar uyuşmazlığı otomatik teslimatı durdurur. Sonuç ve iptal sayfaları yalnızca yetkili kullanıcının sunucudaki siparişini okur; URL'deki `status=paid` gibi alanlara güvenmez.

## Admin ve işletim

Siparişler paneli WEQ/Shopier numaralarını, ürün/paketi, tutarı, ödeme/tarih/teslimat/iade durumunu gösterir; ödeme yöntemi filtresi ve Shopier numarası araması vardır. Arama ve ödeme yöntemi filtresi yüklenmiş kayıtlara uygulanır; eski kayıtları sayfalayarak yükleyin. Ödeme ve iade durumları menüden keyfi olarak paid/refunded yapılamaz.

Yetkili yönetici, parola ve işlem gövdesine bağlı tek kullanımlık onayla Shopier kaydını yeniden doğrular, doğrulanmış teslimatı tekrar dener veya bağlantıyı kapatır. Başarısız kalıcı işler panelden yeniden kuyruğa alınabilir. Bu işlemler audit'e yazılır. Finansal kullanıcı ve görüntüleyici rolleri mevcut izin politikalarına tabidir.

İade bildirimleri `refund.updated` aboneliğinden gelir ve hem refund hem order API kaydıyla karşılaştırılır. Tam iade status=refunded olur; kısmi/bekleyen iade teslimatı incelemeye bırakır. Eski bildirim tam iadeyi tekrar paid yapamaz. Proje otomatik canlı iade veya gerçek sağlayıcı lisans iptali başlatmaz.

Terk edilen ödeme bağlantılarının rezervasyonu otomatik süreyle bırakılmaz. Admin önce Shopier listesini kapatır, ödemeyi sorgular; en az 10 dakika sonra ikinci kontrolde rezervasyonu serbest bırakabilir. Geç tahsilat olursa paid + yönetici incelemesi yapılır; stok başka siparişe verildiyse yanlış key teslim edilmez. Açık rezervasyonları izleyin. Servisin uyuması, worker işlemlerini yeniden uyanana kadar geciktirir; üretimde kesintisiz çalışan servis gerekir.

## Veri ve mimari

Frontend vanilla ES modülleri, backend Express/CommonJS, kalıcı kayıtlar Firebase Admin/Firestore'dur. Katalog temel JSON + Firestore ayarlarıyla genişletilir. Bakiye/Telegram akışları, kullanıcı/admin güvenliği ve stok kasası korunmuştur. Android/iOS kategorileri ve yatay kaydırma yeniden yazılmamıştır. Mevcut koleksiyonlarda toplu silme veya veri göçü yapılmaz.

Yeni kalıcı koleksiyonlar `shopierCheckoutAttempts`, `shopierProducts`, `shopierPayments`, `shopierWebhookReceipts`, `shopierJobs`'tır. Ham webhook gövdesi, PAT veya imza token'ları depolanmaz. Ödeme ve idempotency kayıtları replay koruması için korunur; bunlara otomatik TTL eklemeyin. Yeni indeks `storeOrders(uid, shopierOpen)` içindir. Firestore'un tarayıcı erişimini reddeden kuralları korunur.

Canlı kurulumda yeni PAT, iki abonelik, izinler, HTTPS erişimi ve kontrollü kabul doğrulaması operatör tarafından tamamlanmalıdır. Gerçek Shopier/Render hesabında oturum açılmadı; canlıya deploy, tahsilat ve iade yapılmadı. Ayrıntılı dosya ve test dökümü `SHOPIER_TESLIM_RAPORU.md` ve `TEST_SONUCLARI.json` dosyalarındadır.
