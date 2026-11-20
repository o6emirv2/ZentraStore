import { escape as e, icon } from "../public/js/app/ui.js?v=109";

const requirements = {
  api_base_url: "Gerçek HTTPS API adresi ve sürümü",
  authentication: "Anahtarın gönderileceği başlık ve yetkilendirme biçimi",
  account_balance: "Bayi bakiyesi ve para birimi yanıtı",
  product_catalog: "Benzersiz ürün ve paket kimlikleri",
  package_stock_price: "Paketin güncel stok ve alış fiyatı",
  purchase: "Satın alma isteği ve kesin ret durumları",
  idempotency: "Aynı isteğin ikinci satın almaya dönüşmesini önleyen yöntem",
  order_lookup: "Yanıt kaybında aynı işlemi yeniden sorgulama",
  license_response: "Benzersiz sipariş referansı ve lisans yanıtı",
};

export function supplierView(connection = {}) {
  const configured = connection.configured === true;
  const fields = [...(connection.missing || []), ...(connection.invalid || [])];
  return `<header class="admin-view-header supplier-header"><div><span class="eyebrow">BAYİ API YÖNETİMİ</span><h1>Hilehanem<span class="accent-dot">.</span></h1><p>Bayi API bağlantısı, alış bakiyesi ve tedarik hazırlığı.</p></div><button type="button" class="button secondary small" data-admin-action="supplier-check">${icon("refresh")}<span>Yapılandırmayı kontrol et</span></button></header>
  <div class="notice warning" role="status"><div><b>${configured ? "API bilgileri kayıtlı · teknik belge bekleniyor" : "API yapılandırması eksik"}</b><p>Bağlantı doğrulanmadı. API anahtarı girilmesi tek başına stok, bakiye veya satın alma bağlantısını etkinleştirmez.</p></div></div>
  <div class="stat-grid supplier-metrics"><article class="stat-card"><header><span>Hilehanem alış bakiyesi</span>${icon("wallet")}</header><div class="stat-number">Doğrulanmadı</div><small>USD · Zentra satış bakiyesinden ayrıdır</small></article><article class="stat-card"><header><span>Stok senkronizasyonu</span>${icon("box")}</header><div class="supplier-time">Etkin değil</div><small>Sağlayıcı stok yanıtı henüz doğrulanmadı</small></article><article class="stat-card"><header><span>Otomatik satın alma</span>${icon("shield")}</header><div class="supplier-time">Etkin değil</div><small>Satın alma ve işlem sorgulama belgesi gerekli</small></article></div>
  ${fields.length ? `<section class="panel supplier-settings"><h2>Render bağlantı alanları</h2><p>Gizli anahtar yalnızca backend ortamında tutulur. Aşağıdaki eksik veya geçersiz alanları kontrol et.</p><ul>${fields.map((name) => `<li><code>${e(name)}</code></li>`).join("")}</ul></section>` : ""}
  <section class="panel supplier-settings"><h2>Bağlantıyı tamamlamak için gerekenler</h2><p>Hilehanem'in bayi API belgesi veya gizli değerleri çıkarılmış örnek istek ve yanıtları gereklidir.</p><ul>${(connection.requirements || Object.keys(requirements)).map((key) => `<li>${e(requirements[key] || key)}</li>`).join("")}</ul><p class="fine-print">Bu kontrol sağlayıcıdan ürün satın almaz. Önceki bağlantıdan kalmış bakiye bilgileri burada güncel bakiye olarak kullanılmaz.</p></section>`;
}
