const DEFAULT = {
  theme: "dark",
  language: "tr",
  textScale: 100,
  highContrast: false,
  reducedMotion: false,
};
let current = { ...DEFAULT };
try {
  const saved = JSON.parse(localStorage.getItem("zentra-display-v1"));
  if (saved && typeof saved === "object") current = { ...DEFAULT, ...saved };
} catch {}
export function applyPreferences(input = {}) {
  const root = document.documentElement;
  current = { ...current, ...input };
  current.theme = "dark";
  if (![100, 115, 130, 150, 200].includes(current.textScale))
    current.textScale = 100;
  if (!["tr", "en"].includes(current.language)) current.language = "tr";
  root.dataset.textScale = String(current.textScale);
  root.dataset.theme = "dark";
  root.dataset.contrast = current.highContrast === true ? "high" : "normal";
  root.dataset.motion = current.reducedMotion === true ? "reduce" : "system";
  root.style.setProperty("--reading-scale", current.textScale / 100);
  root.lang =
    typeof location !== "undefined" && location.pathname.startsWith("/admin")
      ? "tr"
      : current.language;
  try {
    const { theme, language, textScale, highContrast, reducedMotion } = current;
    localStorage.setItem(
      "zentra-display-v1",
      JSON.stringify({
        theme,
        language,
        textScale,
        highContrast,
        reducedMotion,
      }),
    );
  } catch {}
  return { ...current };
}
export const displayPreferences = () => ({ ...current });
const dictionary = {
  "Ürün ara": "Search products",
  "Ürün sıralaması": "Sort products",
  "Mağaza özellikleri": "Store benefits",
  "Mobil gezinme": "Mobile navigation",
  "Başlangıç fiyatı": "From",
  "Senin dünyan, senin seçimin": "Your world, your choice",
  KEŞFET: "EXPLORE",

  "Görünüm & dil": "Display & language",
  "Uygulamayı yükle": "Install app",
  Paket: "Package",
  Günlük: "Daily",
  Haftalık: "Weekly",
  Aylık: "Monthly",
  Yıllık: "Annual",
  Ömürlük: "Lifetime",
  "1 Gün": "1 day",
  "7 Gün": "7 days",
  "30 Gün": "30 days",
  "24 Saat": "24 hours",
  "Güvenli giriş yap": "Sign in securely",
  "Şifremi unuttum": "Forgot password",
  "Bu cihazda oturumumu açık tut": "Keep me signed in on this device",
  "Hesap bilgilerin yalnızca hesap ve sipariş işlemlerinde kullanılır. Ayrıntıları gizlilik alanından inceleyebilirsin.":
    "Your details are used for account and order services. See the privacy information for details.",
  Hesabın: "Your account",
  "Dijital dünyanızın yeni adresi.":
    "Your new destination for digital products.",
  "Dijital dünyanda bir adım önde.": "A step ahead in your digital world.",
  "Android ve iOS için seçilmiş ürünler.":
    "Selected products for Android and iOS.",
  "Birlikte daha iyiyiz.": "Better together.",
  "Haberler ve destek için topluluğumuza katıl.":
    "Join our community for news and support.",
  "Gizlilik & veri": "Privacy & data",
  "Satın alma bilgileri": "Purchase information",
  "HTTPS ile güvenli bağlantı": "Secure HTTPS connection",
  "Dijital teslimat": "Digital delivery",
  "Ürününe uygun teslimat seçenekleri": "Delivery options for your product",
  "Sunucuda doğrulanan işlemler": "Server-verified actions",
  "Telegram desteği": "Telegram support",
  "Soruların için doğrudan iletişim": "Direct help with your questions",
  "Her şey hesabında": "Everything in your account",
  "Siparişlerin ve teslimatların bir arada":
    "Your orders and deliveries together",
  "TAM SANA GÖRE": "MADE FOR YOU",
  "Senin dünyan, senin seçimin.": "Your world, your choice.",
  "Daha fazlasını keşfet": "Discover more",
  "Deneyimini yenile": "Refresh your experience",
  "Yeni paketleri gör": "See new packages",
  "Farklı seçenekler": "Different options",
  "ZENTRA TOPLULUĞU": "ZENTRA COMMUNITY",
  "Birlikte bir adım öndeyiz.": "One step ahead together.",
  "Gelişmeleri takip et, ihtiyacın olduğunda bize ulaş.":
    "Follow updates and reach us when you need help.",
  "Topluluğa katıl": "Join the community",
  Tümü: "All",
  "Her zaman yanındayız": "We are here to help",
  "Öne çıkanlar": "Featured",
  "GBOX KEŞFET": "EXPLORE GBOX",
  "Yönetim merkezi": "Admin workspace",
  "Seçtiğin ürünler ve teslimat bilgileri burada görünecek.":
    "Your products and deliveries will appear here.",
  "Henüz siparişin yok": "You have no orders yet",
  "Daha fazla göster": "Show more",
  "Hediye alıcısı (isteğe bağlı)": "Gift recipient (optional)",
  "Doğrulanmış kullanıcı adı": "Verified username",
  "Yalnızca hediye gönderimine açık ürünlerde kullanılır.":
    "Available only for products that support gifts.",
  "İndirim kodu": "Discount code",
  "Kesin fiyat ve stok sipariş anında doğrulanır. Telegram siparişi, ödemenin onaylandığı anlamına gelmez.":
    "Final price and stock are verified when submitting. A Telegram order does not confirm payment.",
  "Ödeme ve teslimat için destek ekibiyle iletişim kur.":
    "Contact support for payment and delivery.",
  "Giriş yaparak görüntüle": "Sign in to view",
  "Uygun bakiye ve doğrulanmış stokla otomatik teslimat yapılır.":
    "Automatic delivery requires sufficient balance and verified stock.",
  "Stok bulunmadığında Telegram üzerinden uygunluğu sorabilirsin.":
    "Ask support about availability when stock is unavailable.",
  "Bu ürün Telegram üzerinden görüşülerek teslim edilir. Otomatik teslimat uygulanmaz.":
    "This product is delivered through Telegram support. Automatic delivery is unavailable.",
  "Kullanılabilir bakiyen": "Available balance",
  Doğrulanamadı: "Not verified",
  "ZENTRA HESABIN": "YOUR ZENTRA ACCOUNT",
  "Siparişlerin ve dijital dünyan kontrolün altında.":
    "Your orders and digital products, in one place.",
  "Doğum tarihi kayıtlı değil": "Date of birth not recorded",
  "E-posta doğrulanmış": "Email verified",
  "E-posta henüz doğrulanmamış": "Email not verified",
  "Siparişlerin bir arada": "Your orders together",
  "Ödeme durumunu, sipariş adımlarını ve teslimat bilgilerini hesabından takip et.":
    "Track payments, order progress and deliveries in your account.",
  "Sana ait kodlar": "Your codes",
  "Bakiye kodunu hesabına tanımla, kullanılabilir indirimlerini incele.":
    "Redeem a balance code and view available discounts.",
  "Bakiye kodunu kullan": "Redeem a balance code",
  "Geçerli bakiye kodun sunucuda doğrulandıktan sonra hesabına uygulanır.":
    "A valid balance code is applied after server verification.",
  "Bakiye kodunu gir": "Enter balance code",
  "Yeni stok ve hesap bildirimleri burada görünecek.":
    "New stock and account notifications appear here.",
  "Aklına takılanlar.": "Your questions, answered.",
  "Bir mesaj kadar yakınız": "We are a message away",
  "Siparişin veya ürünlerin hakkında bize ulaş.":
    "Contact us about your order or products.",
  "İletişime geç": "Contact us",
  "Sipariş desteği": "Order support",
  "Bilgi merkezi": "Knowledge center",
  "Geri dön": "Go back",
  "GÜNCEL KAL": "STAY UP TO DATE",
  "HER ADIMI TAKİP ET": "TRACK EVERY STEP",
  "SIRADAKİ ADIMIN": "YOUR NEXT STEP",
  "Sepetin boş": "Your cart is empty",
  "Aradığın ürünü bulamadık": "No matching product found",
  "Favori listen henüz boş": "Your favorites list is empty",
  "Beğendiğin ürünlerdeki kalp simgesine dokun.":
    "Tap the heart on products you like.",
  "Farklı bir kelimeyle ara veya filtrelerini temizle.":
    "Try another keyword or clear the filters.",

  "Ana sayfa": "Home",
  Anasayfa: "Home",
  Keşfet: "Explore",
  Ürünler: "Products",
  Sepetim: "My cart",
  Siparişlerim: "My orders",
  Siparişler: "Orders",
  Hesabım: "My account",
  "Giriş yap": "Sign in",
  "Giriş Yap": "Sign in",
  "Kayıt ol": "Register",
  "Kayıt Ol": "Register",
  Favorilerim: "My favorites",
  Favoriler: "Favorites",
  Bildirimler: "Notifications",
  Kuponlarım: "My coupons",
  Destek: "Support",
  "Çıkış yap": "Sign out",
  "Sepete ekle": "Add to cart",
  "Favorilere ekle": "Save favorite",
  Favorilerinde: "Saved",
  Stokta: "In stock",
  "Stok bekleniyor": "Awaiting stock",
  "Stok doğrulanamadı": "Stock not verified",
  "Telegram ile": "Via Telegram",
  "Paket seçimi": "Choose a package",
  "Ürün, paket veya kategori ara": "Search products, packages or categories",
  "Tüm ürünler": "All products",
  "Tümünü gör": "View all",
  Filtrele: "Filter",
  "Önerilen sıralama": "Recommended order",
  "Fiyat: düşükten yükseğe": "Price: low to high",
  "Fiyat: yüksekten düşüğe": "Price: high to low",
  "İsme göre A–Z": "Name A–Z",
  "Yeniden dene": "Try again",
  "Bağlantı tamamlanamadı": "Connection failed",
  Kaldır: "Remove",
  Kaydet: "Save",
  Vazgeç: "Cancel",
  Onayla: "Confirm",
  "Pencereyi kapat": "Close dialog",
  "Sipariş özeti": "Order summary",
  Ürünler: "Products",
  Toplam: "Total",
  Uygula: "Apply",
  "İndirim kodun var mı?": "Have a discount code?",
  "Bakiye ile öde": "Pay with balance",
  "Telegram üzerinden görüş": "Contact via Telegram",
  "Ödeme yöntemi": "Payment method",
  "Sepetin henüz boş": "Your cart is empty",
  "Ürünleri keşfet": "Explore products",
  "Satışta olmayan paket": "Unavailable package",
  "SANA AİT AVANTAJLAR": "YOUR BENEFITS",
  "Yeni favorini keşfet": "Find your next favorite",
  "Keşfetmeye devam et.": "Keep exploring.",
  "Android ürünleri": "Android products",
  "iOS ürünleri": "iOS products",
  "Hesap güvenliği": "Account security",
  "Profil bilgilerin": "Profile details",
  "Bilgilerimi düzenle": "Edit my details",
  "Güvenlik ayarları": "Security settings",
  "Siparişlerimi gör": "View my orders",
  "Güncel kal": "Stay up to date",
  "E-posta veya kullanıcı adı": "Email or username",
  Şifre: "Password",
  "Şifreni yenile": "Reset your password",
  "Giriş yapılıyor…": "Signing in…",
  "Hesap oluştur": "Create account",
  "Yeniden hoş geldin.": "Welcome back.",
  "Kaldığın yerden keşfetmeye devam et.":
    "Continue exploring where you left off.",
  Ad: "First name",
  Soyad: "Last name",
  "Kullanıcı adı": "Username",
  "E-posta": "Email",
  "Doğum tarihi": "Date of birth",
  "Hesap şifren": "Account password",
  "Bu bilgiler sana özeldir. Güvenli bir yerde sakla.":
    "These details are private. Keep them safe.",
  "Teslimat bilgilerin": "Your delivery details",
  Kopyala: "Copy",
  "Ödeme bekliyor": "Awaiting payment",
  "Ödeme inceleniyor": "Payment under review",
  "Ödeme reddedildi": "Payment rejected",
  "Ödeme onaylandı": "Payment confirmed",
  Hazırlanıyor: "Preparing",
  "Teslimat bekliyor": "Awaiting delivery",
  "Teslim edildi": "Delivered",
  "İptal edildi": "Cancelled",
  "İade tamamlandı": "Refund completed",
  "İptali onayla": "Confirm cancellation",
  "İptal nedeni": "Cancellation reason",
  "Her şey güncel": "You are up to date",
  "Okundu olarak işaretle": "Mark as read",
  "Kodu kopyala": "Copy code",
  "Kodu kullan": "Redeem code",
  "Güvenli alışveriş": "Secure shopping",
  "Hızlı teslimat": "Fast delivery",
  "Yardım & destek": "Help & support",
  "SENİN İÇİN SEÇTİK": "SELECTED FOR YOU",
  "DİJİTAL DÜNYANI KEŞFET": "EXPLORE YOUR DIGITAL WORLD",
  "Önceki siparişinin sonucu kontrol edilmeli.":
    "Check the result of your previous order.",
  "Sonucu kontrol et": "Check result",
  "Otomatik teslimat": "Automatic delivery",
  "Destek ekibi üzerinden teslimat": "Delivery through support",
  "Fiyat ve stok, sipariş sırasında sunucuda doğrulanır.":
    "Price and stock are verified by the server at checkout.",
  "Stok gelince haber ver": "Notify me when available",
  Mağaza: "Store",
  "Hesap tercihleri": "Account preferences",
  "Paket karşılaştırması": "Package comparison",
  "Güncel sürüm": "Current version",
  "Kurulum açıklaması": "Setup instructions",
  Gereksinimler: "Requirements",
  "Doğrulanmış satın alma": "Verified purchase",
  Değerlendirmeler: "Reviews",
  "Henüz değerlendirme yok.": "No reviews yet.",
  "Gerçek fiyat geçmişi": "Recorded price history",
  "Önceki fiyat kayıtları oluşturulmadı.":
    "No earlier prices have been recorded.",
  "Paket bağlantısını paylaş": "Share package link",
  "Takip ve bildirimler": "Product notifications",
  "Fiyat düşüşü": "Price drops",
  "Stok bildirimi": "Stock availability",
  "İşlem tamamlandı.": "Operation confirmed.",
  "Teslim aldım": "Acknowledge delivery",
  "Tekrar sipariş ver": "Order again",
  "Sipariş adımları": "Order timeline",
  "Destek talebi aç": "Open support ticket",
  "İade / iptal talebi": "Refund / cancellation request",
  "Değerlendirme yaz": "Write a review",
};
export function tr(turkish, english) {
  return document.documentElement?.lang === "en" ? english : turkish;
}
function englishValue(value) {
  if (dictionary[value]) return dictionary[value];
  let m;
  if ((m = /^(.*) detayını gör$/.exec(value)))
    return "View " + m[1] + " details";
  if ((m = /^(.*) favori seçimini değiştir$/.exec(value)))
    return "Toggle " + m[1] + " favorite";
  if ((m = /^(.*) paket seç$/.exec(value)))
    return "Choose " + m[1] + " package";
  if ((m = /^Stokta · Son (\d+) adet$/.exec(value)))
    return "In stock · " + m[1] + " left";
  if ((m = /^(\d+) ürün$/.exec(value))) return m[1] + " products";
  return "";
}
const originalText = new WeakMap(),
  originalAttributes = new WeakMap();
export function translate(root = document.body) {
  if (!root) return;
  const english = document.documentElement?.lang === "en";
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("script,style,code,textarea,[data-user-content]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let n;
  while ((n = walk.nextNode())) {
    const original = originalText.get(n) || n.nodeValue,
      stripped = original.trim(),
      key = stripped.replace(/\s+/g, " ");
    const translated = englishValue(key);
    if (translated) {
      if (!originalText.has(n)) originalText.set(n, original);
      n.nodeValue = english ? original.replace(stripped, translated) : original;
    }
  }
  for (const el of root.querySelectorAll("[placeholder],[aria-label],[title]"))
    for (const attr of ["placeholder", "aria-label", "title"]) {
      const saved = originalAttributes.get(el) || {},
        value = saved[attr] || el.getAttribute(attr);
      const translated = englishValue(value);
      if (translated) {
        saved[attr] = value;
        originalAttributes.set(el, saved);
        el.setAttribute(attr, english ? translated : value);
      }
    }
}
if (
  typeof document !== "undefined" &&
  document.documentElement?.style &&
  document.documentElement?.dataset
)
  applyPreferences();
