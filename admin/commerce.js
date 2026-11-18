import {
  escape as e,
  money,
  date,
  modal,
  field,
  toast,
  busy,
  safeImage,
  status,
} from "../public/js/app/ui.js?v=108";
import { prepareProductImage } from "./product-image-upload.js?v=108";
const BASE = "/api/admin/store/commerce";
const btn = (action, label, id = "", extra = "") =>
  `<button type="button" class="button secondary small" data-commerce-admin="${e(action)}" data-id="${e(id)}" ${extra}>${e(label)}</button>`;
const check = (name, label, value) =>
  `<label class="checkbox"><input name="${e(name)}" type="checkbox" ${value ? "checked" : ""}>${e(label)}</label>`;
const area = (name, label, value = "", extra = "") =>
  `<label class="field"><span>${e(label)}</span><textarea name="${e(name)}" ${extra}>${e(value)}</textarea></label>`;
const select = (name, label, options, value = "") =>
  `<label class="field"><span>${e(label)}</span><select name="${e(name)}">${options.map(([id, label]) => `<option value="${e(id)}" ${String(id) === String(value) ? "selected" : ""}>${e(label)}</option>`).join("")}</select></label>`;
const panel = (title, body) =>
  `<section class="panel commerce-panel"><h2>${e(title)}</h2>${body}</section>`;
const empty = () => '<p class="fine-print">Bu alanda kayıt bulunmuyor.</p>';
const header = (title, message, actions = "") =>
  `<header class="admin-view-header"><div><span class="eyebrow">ZENTRA OPERASYON</span><h1>${e(title)}</h1><p>${e(message)}</p></div><div class="commerce-product-actions">${actions}</div></header>`;
const localTime = (value) =>
  value
    ? new Date(value - new Date(value).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
export function createCommerceWorkspace({ api, can, refresh, context }) {
  let alive = true,
    serial = 0,
    cache = new Map();
  async function call(path, options = {}) {
    const generation = serial,
      r = await api(BASE + path, options);
    if (!alive || generation !== serial)
      throw new Error("Yönetim oturumu değişti.");
    return r.result;
  }
  const mutation = async (path, body = {}, method = "POST") =>
    call(path, { method, body });
  const products = async () => {
    const r = await api("/api/admin/store/catalog?stock=0");
    return r.products || r.catalog?.products || [];
  };
  function download(name, value, type = "text/csv;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([value], { type })),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function render(view) {
    cache.clear();
    if (view === "commerce-catalog") {
      const rows = await products();
      return (
        header(
          "İçerik stüdyosu",
          "Ürün içeriği, galeri, çeviri, SEO ve sürümler ayrı taslakta hazırlanır. Fiyat ve stok mevcut ürün yönetiminden düzenlenir.",
          btn("bulk", "Toplu düzenleme") +
            btn("csv-export", "CSV dışa aktar") +
            btn("csv-import", "CSV içe aktar"),
        ) +
        `<div class="account-card-grid">${rows.map((p) => panel(p.name, `<div class="commerce-product-preview"><img src="${e(safeImage(p.image))}" width="72" height="72" alt="${e(p.name)}"><div><p>${e(p.id)} · ${p.active === false ? "Arşiv / taslak" : "Yayında"}</p>${btn("content", "İçeriği düzenle", p.id)}${btn("impact", "Bağımlılıkları incele", p.id)}</div></div>`)).join("")}</div>`
      );
    }
    if (view === "commerce-support") {
      const [tickets, requests, reviews, knowledge] = await Promise.all([
        call("/tickets"),
        call("/requests"),
        call("/reviews"),
        call("/knowledge"),
      ]);
      cache.set("knowledge", knowledge);
      return (
        header(
          "Müşteri deneyimi",
          "Gerçek siparişlere bağlı destek, talepler, değerlendirmeler ve ekip atamaları.",
          can("store.support.write") ? btn("knowledge", "Bilgi merkezi") : "",
        ) +
        panel(
          "Destek talepleri",
          tickets.items
            .map(
              (t) =>
                `<article class="commerce-row"><div><h3>${e(t.subject)}</h3><p>${e(t.orderNumber)} · ${e(t.status)} · ${date(t.updatedAt)}</p><small>${t.assigneeUid ? "Sorumlu: " + e(t.assigneeUid) : "Henüz atanmadı"}${t.satisfaction ? " · Müşteri puanı: " + e(t.satisfaction.rating) + "/5" : ""}</small></div><div>${btn("ticket", "Görüşme", t.id)}${can("store.support.write") ? btn("assign-ticket", "İş ata", t.id) : ""}</div></article>`,
            )
            .join("") || empty(),
        ) +
        panel(
          "Ürün, iptal ve iade talepleri",
          requests.items
            .map(
              (r) =>
                `<article class="commerce-row"><div><h3>${e(r.subject)}</h3><p>${e(r.kind)} · ${e(r.status)} · ${e(r.orderId || "Ürün önerisi")}</p><p data-user-content>${e(r.message)}</p></div>${can("store.support.write") ? btn("request", "Yanıtla", r.id) : ""}</article>`,
            )
            .join("") || empty(),
        ) +
        panel(
          "Doğrulanmış değerlendirmeler",
          reviews.items
            .map(
              (r) =>
                `<article class="commerce-row"><div><h3>${e(r.title)} · ${e(r.rating)}/5</h3><p>${e(r.productId)} · ${e(r.status)} · ${date(r.createdAt)}</p><p data-user-content>${e(r.message)}</p></div>${can("store.support.write") ? btn("review", "Görünürlüğü yönet", r.id) : ""}</article>`,
            )
            .join("") || empty(),
        ) +
        `<p class="fine-print">Her bölüm son 30 kaydı gösterir.</p>`
      );
    }
    if (view === "commerce-bulk") {
      const jobs = await call("/bulk");
      return (
        header(
          "Onaylı toplu düzenleme",
          "Önizleme, güncel veri kontrolü ve isteğe bağlı ikinci yönetici onayı.",
          btn("bulk", "Yeni önizleme") + btn("csv-import", "CSV içe aktar"),
        ) +
        panel(
          "İşlem kayıtları",
          jobs.items
            .map(
              (j) =>
                `<article class="commerce-row"><div><h3>${e(j.updates.length)} ürün · ${e(j.state)}</h3><p>${date(j.createdAt)} · ${j.approvalRequired ? "İkinci onay gerekli" : "Standart onay"} · ${j.approvedBy ? "Onaylandı" : "Onay bekliyor"}</p></div>${btn("job", "Önizlemeyi aç", j.id)}</article>`,
            )
            .join("") || empty(),
        )
      );
    }
    if (view === "commerce-reports") {
      const r = await call("/reports");
      return (
        header(
          "Satış ve maliyet analizi",
          "Görüntüleme ve sepete ekleme gözlemleri ile doğrulanmış ödemeler ayrı hesaplanır.",
        ) +
        `<div class="notice">Gözlem kapsamı: ${r.scope.events}/${r.scope.eventLimit} olay, ${r.scope.orders}/${r.scope.orderLimit} sipariş. ${r.scope.mayBeTruncated ? "Daha eski kayıtlar kapsam dışında kalabilir." : "Yalnızca kaydedilmiş olaylar kullanıldı."}</div>` +
        panel(
          "Ürün performansı",
          `<div class="commerce-table-wrap"><table><thead><tr><th>Ürün</th><th>Görüntüleme</th><th>Sepete ekleme</th><th>Ödenen sipariş satırı</th><th>Adet</th>${r.profit ? "<th>Ürün brüt tutarı</th>" : ""}</tr></thead><tbody>${r.products.map((p) => `<tr><td>${e(p.productId)}</td><td>${e(p.views)}</td><td>${e(p.cartAdds)}</td><td>${e(p.paidOrders)}</td><td>${e(p.units)}</td>${r.profit ? `<td>${money(p.revenueKurus)}</td>` : ""}</tr>`).join("")}</tbody></table></div>`,
        ) +
        (r.profit
          ? panel(
              "Doğrulanmış katkı hesabı",
              `<div class="notice ${r.profit.verified ? "" : "error"}">${r.profit.verified ? "Maliyet ve işlem ücretleri kapsam içindeki tüm ödenen siparişlerde doğrulandı." : "Maliyet veya işlem ücreti eksik. Tam kâr hesaplanamaz."}</div><p>Kapsanan sipariş: ${r.profit.coveredOrders}/${r.profit.paidOrders}</p><p>Net satış: ${money(r.profit.revenueKurus)} · Maliyet: ${money(r.profit.costKurus)} · İşlem ücreti: ${money(r.profit.feesKurus)}</p><p><b>Katkı: ${r.profit.verified ? money(r.profit.contributionKurus) : "Doğrulanmadı"}</b></p><p class="fine-print">Genel işletme giderleri ve vergiler bu katkı hesabına dahil değildir.</p>${btn("costs", "Sipariş maliyeti doğrula")}`,
            )
          : "")
      );
    }
    if (view === "commerce-operations") {
      const [config, alerts, email] = await Promise.all([
        call("/settings"),
        call("/alerts"),
        call("/email"),
      ]);
      cache.set("settings", config);
      return (
        header(
          "Sistem operasyonları",
          "Kısmi bakım, gerçek hata gözlemleri ve sağlayıcı bağlantı testleri.",
          can("store.operations.write")
            ? btn("configuration", "Kuralları düzenle")
            : "",
        ) +
        `<div class="account-card-grid">${panel("Bakım alanları", `<p>Katalog: ${config.maintenance.catalog ? "Bakımda" : "Açık"}<br>Hesap: ${config.maintenance.account ? "Bakımda" : "Açık"}<br>Sipariş: ${config.maintenance.orders ? "Bakımda" : "Açık"}</p>`)}${panel("İş kuralları", `<p>Sadakat: ${config.loyalty.enabled ? "Etkin" : "Kapalı"}<br>Toplu işlemlerde ikinci onay: ${config.secondApproval ? "Gerekli" : "İsteğe bağlı"}</p>${can("store.orders.write") ? btn("license", "Lisans tarihlerini doğrula") + btn("assign-order", "Siparişe sorumlu ata") : ""}`)}${can("store.operations.write") ? panel("Bağlantı testi", `<p>Veritabanı testi gerçek okuma yapar. Telegram testi, yapılandırılmış yönetici sohbetine bir test iletisi gönderir.</p>${btn("diagnostic-db", "Veritabanını kontrol et")}${btn("diagnostic-telegram", "Telegram test iletisi gönder")}`) : ""}</div>` +
        panel(
          "E-posta bildirim merkezi",
          `<p>Gönderici: ${e(email.from)}<br>Gönderim: ${email.enabled && email.configured ? "Yapılandırıldı — gerçek gönderim sonucu kayıtlarda görünür" : "Yapılandırma bekleniyor"}<br>Teslimat webhook doğrulaması: ${email.webhookConfigured ? "Yapılandırıldı" : "RESEND_WEBHOOK_SECRET bekleniyor"}</p><p>Şifre yenileme göndericisi: ${e(email.recovery?.from || "bildirim@zentrastore.com.tr")}<br>Kurtarma hizmeti: ${email.recovery?.configured ? "API anahtarı ve bağlantı alanı yapılandırıldı; gerçek teslim kaydı kontrol edilmeli" : "RESEND_API_KEY ve CANONICAL_ORIGIN kontrol edilmeli"}<br>Kurtarma çalışanı: ${email.recovery?.worker?.enabled ? "Çalışıyor" : "Çalışmıyor"}</p><p class="fine-print">Hesap kurtarma iletileri isteğe bağlı bildirim anahtarından bağımsızdır. Resend'de zentrastore.com.tr gönderim alanının doğrulanması gerekir.</p><p class="fine-print">Kabul edildi, sağlayıcının isteği aldığı anlamına gelir. Teslim edildi, alıcının posta sunucusunun kabulünü gösterir. Bu durumlar mesajın okunduğunu doğrulamaz. Son ${email.sampleLimit} kayıt gösterilir.</p>${can("store.operations.write") ? btn("email-test", "Kendi adresime test e-postası gönder") : ""}<div class="audit-grid">${email.items.map((r) => `<article class="audit-card"><h3>${e({ stock: "Stok bildirimi", price: "Fiyat bildirimi", license: "Lisans hatırlatması", order_created: "Sipariş oluşturuldu", paid_delivered: "Ödeme ve teslimat", gift_received: "Hediye teslimatı", wallet_credit: "Bakiye eklendi", coupon_assigned: "Kupon tanımlandı", username_changed: "Kullanıcı adı değişti", password_changed: "Şifre değişti", test: "Bağlantı testi", recovery_password: "Şifre yenileme", recovery_username: "Kullanıcı adı hatırlatma" }[r.type] || r.type)}</h3><dl class="audit-fields"><div><dt>Durum</dt><dd>${e({ queued: "Sırada", sending: "Gönderiliyor", retry: "Tekrar denenecek", accepted: "Sağlayıcı kabul etti", delivered: "Alıcı sunucusuna teslim edildi", delayed: "Sağlayıcıda gecikti", failed: "Başarısız", bounced: "Alıcı reddetti", complained: "Spam bildirimi", suppressed: "Gönderim engellendi", skipped: "Gönderilmedi", needs_review: "İnceleme gerekli", uncertain: "Sonuç doğrulanamadı", processing: "Hazırlanıyor", rejected: "Sağlayıcı reddetti", expired: "Süre doldu" }[r.state] || r.state)}</dd></div><div><dt>Alıcı</dt><dd>${e(r.recipient)}</dd></div><div><dt>Tarih</dt><dd>${date(r.createdAt)}</dd></div><div><dt>Deneme / sonuç</dt><dd>${r.attempts} · ${e(r.failureCode || "—")}</dd></div><div><dt>İşlem</dt><dd>${e(r.id)}</dd></div></dl></article>`).join("") || empty()}</div>`,
        ) +
        panel(
          "Kaydedilen sistem uyarıları",
          alerts.items
            .map(
              (a) =>
                `<article class="commerce-row"><div><h3>${e(a.code)}</h3><p>${e(a.path)} · ${e(a.status)} · ${date(a.createdAt)}</p><small>Dakika içindeki ilk gözlem${a.acknowledgedAt ? " · İncelendi" : ""}</small></div>${can("store.operations.write") && !a.acknowledgedAt ? btn("alert", "İncelendi olarak işaretle", a.id) : ""}</article>`,
            )
            .join("") || empty(),
        )
      );
    }
    if (view === "commerce-backups") {
      const r = await call("/backups");
      cache.set("backups", r);
      return (
        header(
          "Yedekleme ve geri dönüş",
          "Firestore yönetilen dışa aktarımı ve ayrı test projesine kontrollü geri yükleme.",
          can("store.backups.write")
            ? btn(
                "backup",
                "Gerçek yedek oluştur",
                "",
                r.configuration.configured ? "" : "disabled",
              )
            : "",
        ) +
        `<div class="notice">Depolama: ${r.configuration.configured ? "Yapılandırıldı" : "FIRESTORE_BACKUP_BUCKET gerekli"} · Ayrı test ortamı: ${r.configuration.restoreConfigured ? "Yapılandırıldı" : "FIRESTORE_RESTORE_TEST_PROJECT gerekli"} · Tutarlı anlık görüntü: ${r.configuration.consistentSnapshot ? "PITR isteği açık" : "PITR doğrulanmadı; tutarlı anlık görüntü iddiası yok"}</div>` +
        panel(
          "Sağlayıcı işlem kayıtları",
          r.items
            .map(
              (b) =>
                `<article class="commerce-row"><div><h3>${e(b.state)}</h3><p>${e(b.sourceProject)} · ${date(b.createdAt)}</p><p>Belge: ${e(b.documentCount ?? "Doğrulanmadı")} · Geri yükleme: ${e(b.restore?.state || "Başlatılmadı")}</p><small>${b.restore?.providerConfirmed ? "Sağlayıcı geri yükleme tamamlandı bilgisini verdi." : "Sağlayıcı sonucu bekleniyor veya işlem başlatılmadı."} Kayıt bazında checksum karşılaştırması: ${b.restore?.recordChecksumsVerified ? "Doğrulandı" : "Doğrulanmadı"}</small></div><div>${btn("backup-refresh", "Sağlayıcı sonucunu sorgula", b.id)}${b.restore?.providerConfirmed ? btn("backup-verify", "Kritik kayıtları karşılaştır", b.id) : ""}${b.state === "completed" && r.configuration.restoreConfigured && !b.restore ? btn("backup-restore", "Test projesine geri yükle", b.id) : ""}</div></article>`,
            )
            .join("") || empty(),
        )
      );
    }
    if (view === "commerce-privacy") {
      const r = await call("/data-requests");
      return (
        header(
          "Veri talepleri",
          "Erişim, düzeltme ve silme incelemeleri. Finansal kayıtların otomatik silinmesi uygulanmaz.",
        ) +
        panel(
          "Müşteri talepleri",
          r.items
            .map(
              (x) =>
                `<article class="commerce-row"><div><h3>${e(x.kind)} · ${e(x.status)}</h3><p>${e(x.uid)} · ${date(x.createdAt)}</p><p data-user-content>${e(x.message)}</p></div>${btn("privacy", "Talebi yanıtla", x.id)}</article>`,
            )
            .join("") || empty(),
        )
      );
    }
    return "";
  }
  async function content(productId) {
    const r = await call("/products/" + productId),
      c = r.draft || r.published || {},
      lang = c.description || {},
      versions = await call("/products/" + productId + "/versions");
    cache.set("content:" + productId, r);
    modal({
      title: r.catalogProduct.name + " · İçerik stüdyosu",
      body: `<p class="fine-print">Taslak sürüm: ${r.revision}. Mağazada yalnızca yayımlanmış içerik görünür. Önizleme bu korumalı pencerede gösterilir.</p>${field("version", "Ürün sürümü", "text", c.version || "", 'maxlength="40"')}${area("descriptionTr", "Türkçe açıklama", lang.tr || "", 'maxlength="4000"')}${area("descriptionEn", "English description", lang.en || "", 'maxlength="4000"')}${area("requirementsTr", "Türkçe gereksinimler", c.requirements?.tr || "", 'maxlength="4000"')}${area("requirementsEn", "English requirements", c.requirements?.en || "", 'maxlength="4000"')}${area("guideTr", "Türkçe kurulum", c.guide?.tr || "", 'maxlength="12000"')}${area("guideEn", "English setup", c.guide?.en || "", 'maxlength="12000"')}${field("estimate", "Teslimat açıklaması", "text", c.deliveryEstimate || "", 'maxlength="240"')}${field("seoTitle", "SEO başlığı", "text", c.seo?.title || "", 'maxlength="80"')}${area("seoDescription", "SEO açıklaması", c.seo?.description || "", 'maxlength="240"')}${field("slug", "Kalıcı ürün yolu", "text", c.seo?.slug || "", 'pattern="[a-z0-9][a-z0-9-]{1,79}" maxlength="80"')}${field("seoImage", "Sosyal paylaşım görseli", "text", c.seo?.image || "", 'maxlength="1000"')}${area("gallery", "Galeri: her satır görsel URL | açıklama", (c.gallery || []).map((x) => x.url + " | " + x.alt).join("\n"))}${btn("upload", "Görsel yükle", productId)}${area("tiers", "Adet indirimi: her satır adet | yüzde", (c.volumeTiers || []).map((x) => x.quantity + " | " + x.percentOff).join("\n"))}${check("gift", "Hediye gönderimine açık", c.giftEligible)}${can("store.wallet.write") ? field("cost", "Birim maliyet (₺; bilinmiyorsa boş)", "number", c.unitCostKurus === null || c.unitCostKurus === undefined ? "" : c.unitCostKurus / 100, 'min="0" step="0.01"') : ""}<details><summary>Sürüm notu ekle</summary>${field("noteVersion", "Not sürümü", "text", "", 'maxlength="40"')}${area("note", "Yayıncı sürüm notu", "", 'maxlength="2000"')}</details><div class="commerce-product-actions">${btn("preview-content", "Kayıtlı taslağı önizle", productId)}${r.draft ? btn("publish", "Kayıtlı taslağı yayımla", productId) : ""}</div>${versions.length ? `<details><summary>Önceki yayımlar (${versions.length})</summary>${versions.map((v) => `<p>${date(v.createdAt)} · r${v.sourceRevision} ${btn("restore-content", "Taslağa geri al", productId, `data-version="${e(v.id)}"`)}</p>`).join("")}</details>` : ""}`,
      submit: "Taslağı kaydet",
      onSubmit: async (data) => {
        const lines = (name) =>
          String(data.get(name) || "")
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean)
            .map((x) => x.split("|").map((y) => y.trim()));
        const notes = [...(c.releaseNotes || [])];
        if (data.get("noteVersion") && data.get("note"))
          notes.unshift({
            version: data.get("noteVersion"),
            message: data.get("note"),
            publishedAt: Date.now(),
          });
        const result = await mutation(
          "/products/" + productId + "/draft",
          {
            expectedRevision: r.revision,
            content: {
              version: data.get("version"),
              description: {
                tr: data.get("descriptionTr"),
                en: data.get("descriptionEn"),
              },
              requirements: {
                tr: data.get("requirementsTr"),
                en: data.get("requirementsEn"),
              },
              guide: { tr: data.get("guideTr"), en: data.get("guideEn") },
              deliveryEstimate: data.get("estimate"),
              seo: {
                title: data.get("seoTitle"),
                description: data.get("seoDescription"),
                slug: data.get("slug"),
                image: data.get("seoImage"),
              },
              gallery: lines("gallery").map(([url, alt]) => ({
                url,
                alt: alt || r.catalogProduct.name,
              })),
              volumeTiers: lines("tiers").map(([quantity, percentOff]) => ({
                quantity: Number(quantity),
                percentOff: Number(percentOff),
              })),
              giftEligible: data.has("gift"),
              ...(can("store.wallet.write")
                ? {
                    unitCostKurus:
                      data.get("cost") === ""
                        ? null
                        : Math.round(Number(data.get("cost")) * 100),
                  }
                : {}),
              releaseNotes: notes.slice(0, 30),
            },
          },
          "PUT",
        );
        toast("Taslak veritabanına kaydedildi.");
        cache.set("content:" + productId, {
          ...r,
          draft: result.draft,
          revision: result.revision,
        });
        refresh();
      },
    });
  }
  async function job(jobId) {
    const j = await call("/bulk/" + jobId);
    modal({
      title: "Toplu ürün önizlemesi",
      body: `<p>${j.updates.length} ürün · ${e(j.state)} · ${j.approvalRequired ? "Farklı yönetici onayı gerekli" : "İkinci onay kapalı"}</p><div class="commerce-table-wrap"><table><thead><tr><th>Ürün</th><th>Mevcut</th><th>Yeni</th></tr></thead><tbody>${j.updates
        .map((u) => {
          const b = j.before.find((x) => x.productId === u.productId);
          return `<tr><td>${e(b.name)}</td><td>${b.plans.map((p) => e(p.key) + ": " + money(p.priceKurus)).join("<br>")}<br>Yayın: ${b.active ? "Açık" : "Kapalı"}<br>Kategori: ${e(b.categoryKey)}</td><td>${Object.entries(
            u.settings.plans || {},
          )
            .map(([k, v]) => e(k) + ": " + money(v.priceKurus))
            .join(
              "<br>",
            )}<br>${u.settings.active === undefined ? "" : u.settings.active ? "Yayına aç" : "Arşivle"}<br>${e(u.settings.categoryKey || "")}</td></tr>`;
        })
        .join(
          "",
        )}</tbody></table></div><p>Süre sonu: ${date(j.expiresAt)} · Onaylayan: ${e(j.approvedBy || "Yok")}</p>${j.uid !== context.uid && j.state === "preview" ? btn("approve-job", "İkinci yönetici olarak onayla", jobId) : ""}${j.uid === context.uid && j.state === "preview" ? field("confirmation", "Uygulamak için UYGULA yaz", "text", "", 'required pattern="UYGULA"') : ""}`,
      submit:
        j.uid === context.uid && j.state === "preview"
          ? "Değişiklikleri uygula"
          : "Kapat",
      onSubmit:
        j.uid === context.uid && j.state === "preview"
          ? async (data) => {
              await mutation("/bulk/" + jobId + "/execute", {
                confirmation: data.get("confirmation"),
              });
              toast("Toplu değişiklikler doğrulandı.");
              refresh();
            }
          : undefined,
    });
  }
  function configuration(config) {
    const l = config.loyalty;
    modal({
      title: "Mağaza iş kuralları",
      body:
        check("catalog", "Katalog bakımda", config.maintenance.catalog) +
        check(
          "account",
          "Hesap işlemleri bakımda",
          config.maintenance.account,
        ) +
        check("orders", "Yeni siparişler bakımda", config.maintenance.orders) +
        field(
          "message",
          "Bakım mesajı",
          "text",
          config.maintenance.message,
          'maxlength="240"',
        ) +
        check(
          "secondApproval",
          "Toplu ürün işlemlerinde farklı yönetici onayı zorunlu",
          config.secondApproval,
        ) +
        check("loyalty", "Sadakat programı etkin", l.enabled) +
        field(
          "points",
          "Her 100₺ için puan",
          "number",
          l.pointsPer100TL,
          'required min="1" max="1000000"',
        ) +
        field(
          "reward",
          "Kupon için puan",
          "number",
          l.rewardPoints,
          'required min="1" max="1000000"',
        ) +
        field(
          "discount",
          "Ödül indirimi (₺)",
          "number",
          l.rewardDiscountKurus / 100,
          'required min="0.01" max="1000" step="0.01"',
        ) +
        field(
          "minimum",
          "Ödül minimum sepet (₺)",
          "number",
          l.minimumSubtotalKurus / 100,
          'required min="0" max="10000" step="0.01"',
        ),
      onSubmit: async (data) => {
        await mutation(
          "/settings",
          {
            expectedRevision: config.revision,
            maintenance: {
              catalog: data.has("catalog"),
              account: data.has("account"),
              orders: data.has("orders"),
              message: data.get("message"),
            },
            secondApproval: data.has("secondApproval"),
            loyalty: {
              enabled: data.has("loyalty"),
              pointsPer100TL: Number(data.get("points")),
              rewardPoints: Number(data.get("reward")),
              rewardDiscountKurus: Math.round(
                Number(data.get("discount")) * 100,
              ),
              minimumSubtotalKurus: Math.round(
                Number(data.get("minimum")) * 100,
              ),
            },
          },
          "PUT",
        );
        toast("Kurallar kaydedildi.");
        refresh();
      },
    });
  }
  async function click(event) {
    const el = event.target.closest("[data-commerce-admin]");
    if (!el || !alive || !el.dataset?.commerceAdmin) return;
    event.preventDefault();
    const actionKey = crypto.randomUUID();
    const a = el.dataset.commerceAdmin,
      id = el.dataset.id;
    busy(el, true);
    try {
      if (a === "content") return await content(id);
      if (a === "preview-content") {
        const r = await call("/products/" + id),
          c = r.draft || r.published || {};
        return modal({
          title: "Korumalı içerik önizlemesi",
          body: `<h3>${e(r.catalogProduct.name)} · ${e(c.version)}</h3><p data-user-content>${e(c.description?.tr || "")}</p>${(c.gallery || []).map((x) => `<figure><img src="${e(safeImage(x.url))}" alt="${e(x.alt)}" width="400" height="300"><figcaption>${e(x.alt)}</figcaption></figure>`).join("")}<p data-user-content>${e(c.requirements?.tr || "")}</p><p data-user-content>${e(c.guide?.tr || "")}</p><p>SEO: ${e(c.seo?.title || "")} · ${e(c.seo?.slug || "")}</p>`,
        });
      }
      if (a === "publish") {
        const r = await call("/products/" + id);
        return modal({
          title: "Ürün içeriğini yayımla",
          body: `<p>Kayıtlı taslak r${r.revision} mağazada görünür hale gelecek. Kaydedilmemiş form değişiklikleri yayımlanmaz.</p>`,
          submit: "Yayımla",
          onSubmit: async () => {
            await mutation("/products/" + id + "/publish", {
              expectedRevision: r.revision,
            });
            toast("İçerik yayımlandı.");
            refresh();
          },
        });
      }
      if (a === "restore-content") {
        const r = await call("/products/" + id);
        await mutation("/products/" + id + "/restore", {
          expectedRevision: r.revision,
          versionId: el.dataset.version,
        });
        toast("Önceki içerik taslağa alındı. Yayımlamak için incele.");
        return;
      }
      if (a === "upload")
        return modal({
          title: "Galeri görseli yükle",
          body: '<label class="field"><span>PNG / JPEG / WebP (en fazla 8 MB kaynak)</span><input name="file" type="file" accept="image/png,image/jpeg,image/webp" required></label>',
          onSubmit: async (data) => {
            const imageUpload = await prepareProductImage(data.get("file")),
              r = await mutation("/products/" + id + "/images", {
                imageUpload,
              });
            modal({
              title: "Görsel yüklendi",
              body: `<p>Bu adresi galeri alanına açıklamasıyla ekleyip taslağı kaydet.</p><code class="commerce-wrap">${e(r.url)}</code><img src="${e(safeImage(r.url))}" alt="Yüklenen ürün görseli" width="400" height="300">`,
            });
          },
        });
      if (a === "impact") {
        const r = await call("/products/" + id + "/impact");
        return modal({
          title: "Arşivleme etki analizi",
          body: `<p>İlgili sipariş: ${r.orders}<br>Aktif rezervasyon: ${r.activeReservations}<br>Değerlendirme: ${r.reviews}<br>Destek: ${r.supportTickets}</p><p>Kalıcı ürün silme kapalıdır. Finansal ilişkiler korunarak ürün arşivlenir. ${r.scope.mayBeTruncated ? "Kapsam sınırı nedeniyle daha eski ilişkiler ayrıca incelenmelidir." : ""}</p>`,
          submit: "Arşiv önizlemesi oluştur",
          onSubmit: async () => {
            const j = await mutation("/bulk/preview", {
              updates: [{ productId: id, settings: { active: false } }],
            });
            await job(j.id);
          },
        });
      }
      if (a === "bulk") {
        const rows = await products();
        return modal({
          title: "Toplu ürün düzenleme",
          body:
            rows.map((p) => check("product:" + p.id, p.name, false)).join("") +
            select(
              "kind",
              "Değişiklik",
              [
                ["discount", "Fiyata indirim yüzdesi"],
                ["active", "Yayına aç"],
                ["archive", "Arşivle"],
                ["category", "Kategori değiştir"],
              ],
              "discount",
            ) +
            field(
              "value",
              "Yüzde veya kategori anahtarı",
              "text",
              "",
              'maxlength="60"',
            ),
          submit: "Önizlemeyi oluştur",
          onSubmit: async (data) => {
            const selected = rows.filter((p) => data.has("product:" + p.id));
            if (!selected.length) throw new Error("En az bir ürün seç.");
            const kind = data.get("kind"),
              value = data.get("value"),
              updates = selected.map((p) => ({
                productId: p.id,
                settings:
                  kind === "discount"
                    ? {
                        plans: Object.fromEntries(
                          p.plans.map((plan) => [
                            plan.key,
                            {
                              priceKurus: Math.max(
                                1,
                                Math.round(
                                  (plan.priceKurus * (100 - Number(value))) /
                                    100,
                                ),
                              ),
                            },
                          ]),
                        ),
                      }
                    : kind === "category"
                      ? { categoryKey: value }
                      : { active: kind === "active" },
              }));
            if (
              kind === "discount" &&
              (!Number.isInteger(Number(value)) ||
                Number(value) < 1 ||
                Number(value) > 50)
            )
              throw new Error("İndirim 1–50 arasında tam sayı olmalı.");
            const j = await mutation("/bulk/preview", { updates });
            await job(j.id);
          },
        });
      }
      if (a === "csv-export") {
        download("zentra-katalog.csv", (await call("/csv")).csv);
        return;
      }
      if (a === "csv-import")
        return modal({
          title: "CSV içe aktar",
          body: '<p>En fazla 100 satır. Sütunlar: productId, planKey, priceKurus, active, categoryKey. Önizleme oluşmadan değişiklik uygulanmaz.</p><label class="field"><span>CSV dosyası</span><input type="file" name="file" accept=".csv,text/csv" required></label>',
          submit: "Doğrula ve önizle",
          onSubmit: async (data) => {
            const f = data.get("file");
            if (f.size > 200000)
              throw new Error("CSV en fazla 200 KB olabilir.");
            const j = await mutation("/bulk/preview", { csv: await f.text() });
            await job(j.id);
          },
        });
      if (a === "job") return await job(id);
      if (a === "approve-job") {
        await mutation("/bulk/" + id + "/approve");
        toast("İkinci yönetici onayı kaydedildi.");
        refresh();
        return;
      }
      if (a === "ticket") {
        const t = await call("/tickets/" + id),
          k = await call("/knowledge");
        return modal({
          title: t.subject,
          body: `<p>${e(t.orderNumber)} · ${e(t.status)}</p>${t.messages.map((m) => `<article class="commerce-message"><small>${e(m.role)} · ${date(m.createdAt)}</small><p data-user-content>${e(m.message)}</p></article>`).join("")}${
            can("store.support.write")
              ? select(
                  "template",
                  "Yanıt şablonu",
                  [
                    ["", "Özel yanıt"],
                    ...k.templates.map((x) => [x.id, x.title]),
                  ],
                  "",
                ) +
                area("message", "Yanıt", "", 'maxlength="4000"') +
                select(
                  "status",
                  "Yeni durum",
                  [
                    ["answered", "Yanıtlandı"],
                    ["resolved", "Çözüldü"],
                    ["open", "Açık"],
                  ],
                  "answered",
                )
              : ""
          }`,
          submit: "Yanıtı gönder",
          onSubmit: can("store.support.write")
            ? async (data, form) => {
                const text =
                  data.get("message") ||
                  k.templates.find((x) => x.id === data.get("template"))?.body;
                await mutation("/tickets/" + id + "/reply", {
                  expectedRevision: t.revision,
                  message: text,
                  status: data.get("status"),
                });
                toast("Destek yanıtı kaydedildi.");
                refresh();
              }
            : undefined,
        });
      }
      if (a === "assign-ticket" || a === "assign-order") {
        const kind = a === "assign-ticket" ? "ticket" : "order",
          staff = await call("/assignees?kind=" + kind);
        return modal({
          title: "İş ataması",
          body:
            (kind === "order" && !id
              ? field(
                  "orderId",
                  "Sipariş referansı",
                  "text",
                  "",
                  'required maxlength="128"',
                )
              : "") +
            select(
              "uid",
              "Sorumlu ekip üyesi",
              staff.map((x) => [x.uid, x.label + " · " + x.role]),
              staff[0]?.uid || "",
            ),
          onSubmit: async (data) => {
            await mutation(
              "/" +
                (kind === "ticket" ? "tickets" : "orders") +
                "/" +
                (id || data.get("orderId")) +
                "/assign",
              { assigneeUid: data.get("uid") },
            );
            toast("İş ataması doğrulandı.");
            refresh();
          },
        });
      }
      if (a === "request")
        return modal({
          title: "Talebi yanıtla",
          body:
            select(
              "status",
              "Durum",
              [
                ["reviewing", "İnceleniyor"],
                ["accepted", "Kabul edildi"],
                ["rejected", "Reddedildi"],
                ["resolved", "Tamamlandı"],
              ],
              "reviewing",
            ) +
            area("reply", "Müşteriye yanıt", "", 'required maxlength="3000"') +
            '<p class="fine-print">İade ve iptal yalnızca gerçek sipariş durumu doğrulandığında tamamlanabilir.</p>',
          onSubmit: async (data) => {
            await mutation("/requests/" + id + "/decision", {
              status: data.get("status"),
              reply: data.get("reply"),
            });
            toast("Talep yanıtı kaydedildi.");
            refresh();
          },
        });
      if (a === "review")
        return modal({
          title: "Değerlendirme görünürlüğü",
          body:
            select(
              "status",
              "Görünürlük",
              [
                ["published", "Yayında"],
                ["hidden", "Gizli"],
              ],
              "published",
            ) +
            field(
              "reason",
              "İşlem gerekçesi",
              "text",
              "",
              'required maxlength="240"',
            ),
          onSubmit: async (data) => {
            await mutation("/reviews/" + id + "/moderate", {
              status: data.get("status"),
              reason: data.get("reason"),
            });
            toast("Görünürlük kaydedildi.");
            refresh();
          },
        });
      if (a === "knowledge") {
        const k = cache.get("knowledge") || (await call("/knowledge"));
        return modal({
          title: "Bilgi merkezi ve yanıt şablonları",
          body:
            "<p>Her kayıt başlığı ve açıklamasıyla sunucuda doğrulanır. Kaynak içeriği HTML olarak çalıştırılmaz.</p>" +
            area(
              "articles",
              "Yazılar: her blok başlık | kimlik | yayında (true/false), sonraki satırlarda metin; bloklar --- ile ayrılır",
              k.articles
                .map((x) => `${x.title} | ${x.id} | ${x.published}\n${x.body}`)
                .join("\n---\n"),
            ) +
            area(
              "templates",
              "Şablonlar: her blok başlık | kimlik, sonraki satırlarda metin; bloklar --- ile ayrılır",
              k.templates
                .map((x) => `${x.title} | ${x.id}\n${x.body}`)
                .join("\n---\n"),
            ),
          onSubmit: async (data) => {
            const parse = (value, published) =>
              String(value)
                .split(/\n---\n/)
                .filter((x) => x.trim())
                .map((x) => {
                  const [head, ...rest] = x.split("\n"),
                    [title, id, visible] = head.split("|").map((x) => x.trim());
                  return {
                    id,
                    title,
                    body: rest.join("\n"),
                    ...(published ? { published: visible === "true" } : {}),
                  };
                });
            await mutation(
              "/knowledge",
              {
                expectedRevision: k.revision,
                articles: parse(data.get("articles"), true),
                templates: parse(data.get("templates"), false),
              },
              "PUT",
            );
            toast("Bilgi merkezi kaydedildi.");
            refresh();
          },
        });
      }
      if (a === "configuration")
        return configuration(
          cache.get("settings") || (await call("/settings")),
        );
      if (a === "license")
        return modal({
          title: "Lisans tarihlerini doğrula",
          body:
            field(
              "orderId",
              "Teslim edilmiş sipariş kimliği",
              "text",
              "",
              'required maxlength="128"',
            ) +
            field(
              "startsAt",
              "Başlangıç (bu cihazın yerel saati)",
              "datetime-local",
              localTime(Date.now()),
              "required",
            ) +
            field(
              "expiresAt",
              "Doğrulanmış bitiş (bu cihazın yerel saati)",
              "datetime-local",
              "",
              "required",
            ) +
            field(
              "source",
              "Doğrulama kaynağı / yayıncı referansı",
              "text",
              "",
              'required maxlength="160"',
            ),
          onSubmit: async (data) => {
            await mutation(
              "/orders/" + data.get("orderId") + "/license",
              {
                startsAt: new Date(data.get("startsAt")).getTime(),
                expiresAt: new Date(data.get("expiresAt")).getTime(),
                source: data.get("source"),
              },
              "PUT",
            );
            toast("Lisans tarihleri kayıtlı kaynağa göre doğrulandı.");
          },
        });
      if (a === "costs")
        return modal({
          title: "Gerçek maliyet ve işlem ücretleri",
          body:
            field(
              "orderId",
              "Sipariş kimliği",
              "text",
              "",
              'required maxlength="128"',
            ) +
            field(
              "cost",
              "Toplam ürün maliyeti (₺)",
              "number",
              "",
              'required min="0" step="0.01"',
            ) +
            field(
              "fees",
              "Toplam işlem ücreti (₺)",
              "number",
              "",
              'required min="0" step="0.01"',
            ) +
            field(
              "source",
              "Muhasebe / belge referansı",
              "text",
              "",
              'required maxlength="200"',
            ),
          onSubmit: async (data) => {
            const orderId = data.get("orderId"),
              r = await call("/orders/" + orderId);
            await mutation(
              "/orders/" + orderId + "/costs",
              {
                expectedRevision: r.costs?.revision || 0,
                costKurus: Math.round(Number(data.get("cost")) * 100),
                feesKurus: Math.round(Number(data.get("fees")) * 100),
                source: data.get("source"),
              },
              "PUT",
            );
            toast("Maliyet ve ücret kanıtı kaydedildi.");
            refresh();
          },
        });
      if (a === "alert") {
        await mutation("/alerts/" + id + "/acknowledge");
        toast("Uyarı incelendi olarak kaydedildi.");
        refresh();
        return;
      }
      if (a === "email-test")
        return modal({
          title: "Gerçek e-posta testi",
          body: "<p>Bu işlem yalnızca giriş yaptığın yönetici hesabının doğrulanmış e-posta adresine bir test iletisi göndermek üzere kuyruğa alır. Sağlayıcı kullanım kotasına sayılır.</p>",
          submit: "Testi kuyruğa al",
          onSubmit: async () => {
            await mutation("/email/test", {
              idempotencyKey: crypto.randomUUID(),
            });
            toast(
              "Test iletisi kuyruğa alındı. Sonucu e-posta bildirim merkezinden kontrol et.",
            );
            refresh();
          },
        });
      if (a.startsWith("diagnostic-")) {
        const r = await mutation("/diagnostic", {
          kind: a === "diagnostic-db" ? "database" : "telegram",
        });
        modal({
          title: "Gerçek bağlantı sonucu",
          body: `<p>${e(r.kind)} · ${r.verified ? "Sağlayıcı sonucu doğrulandı" : "Doğrulanmadı"} · ${date(r.checkedAt)}</p>`,
        });
        return;
      }
      if (a === "backup")
        return modal({
          title: "Gerçek veritabanı yedeği oluştur",
          body: "<p>Yönetilen Firestore dışa aktarımı yapılandırılmış Cloud Storage alanına başlatılır. Sağlayıcı okuma ve depolama ücretleri uygulayabilir. Tamamlanma sonucu ayrıca sorgulanır.</p>",
          submit: "Yedeklemeyi başlat",
          onSubmit: async () => {
            const result = await mutation("/backups", {
              idempotencyKey: actionKey,
            });
            if (!["pending", "completed"].includes(result.state))
              throw new Error(
                "Sağlayıcı sonucu bekleniyor veya doğrulanamadı. Mevcut yedek kaydını kontrol edin.",
              );
            toast("Yedekleme isteğinin sağlayıcı kaydı oluşturuldu.");
            refresh();
          },
        });
      if (a === "backup-verify") {
        const r = await mutation("/backups/" + id + "/verify");
        toast(
          r.verified
            ? "Kritik kayıtların sayısı ve checksum değerleri test ortamıyla eşleşti."
            : "Kayıt karşılaştırması tamamlanmadı.",
        );
        refresh();
        return;
      }
      if (a === "backup-refresh") {
        await mutation("/backups/" + id + "/refresh");
        toast("Sağlayıcıdan güncel işlem sonucu alındı.");
        refresh();
        return;
      }
      if (a === "backup-restore")
        return modal({
          title: "Ayrı test projesine geri yükle",
          body:
            "<p>Üretim projesine geri yükleme engellenir. Hedef test projesindeki çakışan kayıtlar sağlayıcı tarafından üzerine yazılabilir.</p>" +
            field(
              "confirmation",
              "TEST ORTAMINA GERI YUKLE yaz",
              "text",
              "",
              'required pattern="TEST ORTAMINA GERI YUKLE"',
            ),
          submit: "Test geri yüklemesini başlat",
          onSubmit: async (data) => {
            await mutation("/backups/" + id + "/restore", {
              confirmation: data.get("confirmation"),
            });
            toast(
              "Test ortamına geri yükleme isteği kaydedildi. Sağlayıcı sonucu bekleniyor.",
            );
            refresh();
          },
        });
      if (a === "privacy")
        return modal({
          title: "Veri talebini yanıtla",
          body:
            select(
              "status",
              "İnceleme durumu",
              [
                ["reviewing", "İnceleniyor"],
                ["replied", "Yanıtlandı"],
                ["rejected", "Reddedildi"],
              ],
              "reviewing",
            ) +
            area(
              "reply",
              "İşlem sonucu ve saklama gerekçesi",
              "",
              'required maxlength="4000"',
            ),
          onSubmit: async (data) => {
            await mutation("/data-requests/" + id + "/decision", {
              status: data.get("status"),
              reply: data.get("reply"),
            });
            toast("Veri talebi yanıtlandı; finansal kayıtlar korunur.");
            refresh();
          },
        });
    } catch (error) {
      toast(error.message || "İşlem tamamlanamadı.", "error");
    } finally {
      busy(el, false);
    }
  }
  const handler = (event) => void click(event);
  document.addEventListener("click", handler);
  return {
    render,
    dispose() {
      alive = false;
      serial++;
      cache.clear();
      document.removeEventListener("click", handler);
    },
  };
}
