# WEQ / ZENTRA STORE — Güncel teslim raporu

Sürüm: **81.0.1** · Tarih: **18.10.2026 UTC**

Temel: erişilebilir 80.0.0 Shopier kaynakları. İstenen iki bakiye/sepet düzenlemesi bu kaynaklar üzerine yeniden oluşturulup bu çalışmada test edildi. Yeni paket: **ZENTRA-STORE-GUNCEL-v81.0.1.zip**. Canlıya dağıtılmadı; `SHOPIER_ENABLED=false`.

Sepette Shopier alanı stoktan bağımsız görünür. Stok uygun değilse veya sepet boşsa açıkça bakiye yükleme formuna geçilir; bu işlem ürün satın almaz veya stok ayırmaz. Gerçek stoklar değiştirilmez. Stok uygun ürünlerde önceki Shopier ile ürün ödemesi korunur. Hesabım formu 100 TL–10.000 TL tutar ve hazır seçimler sunar.

## A. Güncellenen dosyalar

**52 dosya** güncellendi.

| Dosya | İşlem |
|---|---|
| `README.md` | Güncel bakiye akışı, iade davranışı ve kurulum sınırları. |
| `RENDER_ENV_KURULUM.txt` | Yeni API yolu; ek ENV yok; mevcut gizli değerler korunur. |
| `SHOPIER_TESLIM_RAPORU.md` | Güncel dosya, güvenlik, test ve kalan risk raporu. |
| `TEST_SONUCLARI.json` | Bu sürümde gerçekten çalıştırılan tüm test ve kontrol sonuçları. |
| `admin/admin-core.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `admin/admin-dashboard.js` | Bakiye işlem türü, arama ve iade açığı; ürün teslimat düğmesi sunulmaz. |
| `admin/admin-entry.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `admin/admin-gate.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `admin/admin.html` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `admin/index.html` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `admin/promo-codes.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `admin/session/handoff/index.html` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `index.html` | Stoktan bağımsız Shopier sepet paneli ve Hesabım bakiye formu. |
| `odeme/iptal/index.html` | Aynı güvenli bakiye durum görünümü; finansal iptal yapılmaz. |
| `odeme/sonuc/index.html` | Bakiye yüklemesi için Hesabım bağlantısı. |
| `package-lock.json` | Yalnızca proje sürümü değişti; bağımlılık grafiği aynı. |
| `package.json` | 81.0.1 sürümü ve yeni sunucu modülünün kontrolü. |
| `public/css/storefront-design.css` | Mevcut temaya uygun, mobil ve klavye erişimli ödeme/bakiye stilleri. |
| `public/js/store/account-view.js` | İade sonrası kapatılması gereken tutarı hesapta açıklama. |
| `public/js/store/api.js` | Bakiye yüklemesi için anlaşılır ve güvenli hata mesajları. |
| `public/js/store/auth.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `public/js/store/customer-app.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `public/js/store/customer-renderers.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `public/js/store/order-view.js` | Bakiye işlemini ürün teslimatından ayıran geçmiş kartı. |
| `public/js/store/product-detail.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `public/js/store/product-gallery.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `public/js/store/product-media.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `public/js/store/products.js` | Ürün ödemesi ile bakiye yüklemesinin ayrı kullanılabilirlik bilgisi. |
| `public/js/store/shopier-checkout.js` | Kesin kuruş ayrıştırma, bakiye isteği, ortak ve kalıcı idempotent kurtarma. |
| `public/js/store/shopier-result.js` | Bakiye sonucu ve Hesabım bağlantısı; URL ödeme kanıtı sayılmaz. |
| `public/js/store/showcase-slider.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `public/js/store/storefront.js` | Stok uygun değilken açık bakiye yükleme formu; tutar seçimi, işlem ve bakiye yenileme. |
| `public/js/ui/app-ui.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `public/js/ui/interaction-guard-entry.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `public/js/ui/list-controls.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `public/js/ui/notification-center.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `script.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `scripts/admin-client-regression.cjs` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `scripts/catalog-filter-regression.cjs` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `scripts/experience-regression.cjs` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `scripts/http-regression.cjs` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `scripts/shopier-browser.cjs` | Ürün/bakiye akışları, sıfır stok, mobil/masaüstü, admin ve kapalı ENV testleri. |
| `scripts/shopier-client-regression.cjs` | Tutar ayrıştırma, kalıcı yeniden deneme ve katalog kullanılabilirlik testleri. |
| `server.js` | Yalnızca önbellek/import sürümü; mevcut davranış korunur. |
| `server/core/adminOverviewPolicy.js` | İade açığını mali okuma izni olmayan personelden gizleme. |
| `server/core/adminStoreService.js` | Bakiye yüklemesini ürün cirosuna ve harcamasına tekrar saymama. |
| `server/core/apiContracts.js` | Yeni endpoint için merkezi kuruş sınırları ve dar gövde şeması. |
| `server/core/shopierJobs.js` | Sağlayıcıda unpaid sipariş varken açık ödeme mutabakatını sürdürme. |
| `server/core/shopierService.js` | Stoktan bağımsız topup, atomik ödeme/ledger/bakiye ve iade eşleştirmesi. |
| `server/core/shopierWebhooks.js` | Olay türüne göre ayrılmış deduplication; imza doğrulaması korunur. |
| `server/core/storeService.js` | Bakiye işlem tipi; iade açığında satın alma engeli; topup kullanılabilirliği. |
| `server/routes/shopier.routes.js` | Oturum ve rate limit korumalı topup endpointi; UID oturumdan alınır. |

## B. Eklenen dosyalar

- `server/core/shopierWallet.js`: tutar sınırları, transaction içindeki kredi/iade/ledger/audit işlemleri.
- `scripts/shopier-wallet-regression.cjs`: bakiye, imza, idempotency, yarış, iade, yetki ve mali özet testleri.

## C. Silinen dosyalar ve temizlik

Kaynak dosyası silinmedi. Geçici çıktılar, tarayıcı ekran görüntüleri, loglar, node_modules, özel ENV ve yerel derlemeler ZIP'e alınmaz. Yeni bağımlılık veya kullanılmayan ek MD dosyası yoktur. Mevcut gerekli testler korunur.

## D. Güvenlik düzeltmeleri

Oturum/Origin/App Check, şema ve rate limit yeni endpointte korunur. Müşteri kimliği tarayıcı gövdesinden alınmaz. Tutar kesin kuruşla doğrulanır. Ödeme imzası ve Shopier API kaydı, sipariş/ürün, TRY tutarı ve müşteri e-postası eşleşmeden kredi oluşmaz. Başarı URL'si kanıt değildir. Bakiye, makbuz, değişmez ledger ve audit aynı transaction içinde yazılır; eş zamanlı/replay olaylar ikinci kredi yapmaz. Bakiye yüklemesi ürün teslimatı başlatmaz.

İade net krediyi bir kez geri alır. Harcanmış tutar negatif bakiye yapılmadan storeWalletDebtKurus ile kaydedilir; kapanana kadar satın alma engellenir. Yeni doğrulanmış yükleme önce bu tutarı karşılar; mevcut admin engeli ayrıca korunur. Bakiye yüklemesi ürün cirosuna veya müşteri ürün harcamasına tekrar sayılmaz. Mali özet önbelleği güncellenir; iade açığı uygun personele gösterilir.

Webhook imzası ham gövdede doğrulanır; order/refund anahtarları ayrıdır ve olay türleri ayrı deduplication kapsamındadır. Unpaid kaydı bulunması açık ödeme mutabakatını bitirmez. Kayıp yanıt kurtarması aynı anahtar/gövdeyi korur; kendiliğinden yeni finansal POST göndermez. Gizli anahtar kaynakta/tarayıcıda/logda bulunmaz.

Kullanıcı hesapları, veri, fiyat/paketler, gerçek stok, ayrı Android/iOS kategorileri, yatay kaydırma, mevcut bakiye/Telegram ve admin akışları korunur. Toplu silme veya veri göçü yoktur.

## E. Render

Ek ENV gerekmez. Mevcut 11 Shopier/WEQ değişkeni ve gerçek servis adresleri RENDER_ENV_KURULUM.txt içinde korunur. Aynı yeni PAT ile order.created ve refund.updated aboneliklerinin ayrı token'ları kullanılır. Sohbette paylaşılmış token tekrar kullanılmamalıdır. Yeni API yolu POST /api/payments/shopier/topups, yeni backend yayınıyla açılır; bu çalışmada canlı erişimi doğrulanmadı. Frontend ve backend birlikte yayınlanmalıdır. Mevcut Firebase/Render ayarlarını koruyun.

## F. Çalıştırılan kontroller

**349 otomatik test geçti; 0 başarısız, 0 atlanan. Chromium'da 9 test grubu geçti; sayfa JavaScript hatası yok.** Temiz üretim kurulumu 246 paketle başarılı. Kaynak/HTML/CSS, 34 ürün ve statik frontend build kontrol edildi. Çalışma zamanı bağımlılık taramasında 0 açık var; bağımlılıklar değişmedi. Ayrıntılı gerçek sonuçlar TEST_SONUCLARI.json içindedir.

Testlerde yalnızca dış Firebase/Shopier sınırları izoledir; gerçek proje HTTP, kimlik, imza, iş kuralları ve transaction kodu çalışır. Canlı ödeme veya iade yapılmadı. Katalog, kategori şeması, erişim kuralları, indeksler, CNAME, Render ve .env.example önceki kaynakla bayt düzeyinde aynı kaldı.

## G. Kalan riskler

Gerçek Shopier hesabının mağaza bakiyesi satış biçimine uygunluğu, PAT/abonelik izinleri, canlı HTTPS webhook, gerçek ödeme/iade kabulü, üretim Firestore/IAM ve Render worker sürekliliği ayrıca doğrulanmalıdır. Sağlayıcıya özgü cüzdan API'si icat edilmez; resmî dijital ürün bağlantısı üzerinden yerel bakiye tutulur. Doğrulanmadan Shopier etkinleştirilmez. Mevcut ürün rezervasyon kapama ve geç tahsilat inceleme koşulları README'de korunur.

## H. Paket

Tam frontend, backend, gerekli testler, RENDER_ENV_KURULUM.txt, .env.example, bu rapor ve test sonuçları birlikte teslim edilir. ZIP CRC ve tüm kaynak dosya içerikleri teslim öncesi doğrulanır.
