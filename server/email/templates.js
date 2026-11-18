"use strict";
const { configuration, unsubscribeToken, OPTIONAL } = require("./config");
const { storeEntryUrl } = require("../../public/js/app/routes.mjs");
function escape(value = "") {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
const money = (value) =>
  (value / 100).toLocaleString("tr-TR", { style: "currency", currency: "TRY" });
const date = (value) =>
  new Date(value).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
const TYPES = Object.freeze({
  stock: "stock",
  restock: "restock",
  promo_added: "coupon",
  new_device: "security",
  price: "price",
  license: "license",
  coupon_assigned: "coupon",
  order_created: "order",
  paid_delivered: "order",
  gift_received: "order",
  wallet_credit: "wallet",
  username_changed: "security",
  password_changed: "security",
  test: "test",
});
function render(job, facts, recipient, template = {}) {
  const config = configuration();
  let subject,
    intro,
    rows = [],
    path = "/hesabim",
    label = "Hesabıma git";
  const item = facts.product?.name || "Takip ettiğin ürün";
  switch (job.type) {
    case "promo_added":
      subject = "Yeni bakiye promosyon kodu";
      intro = "Kodu promosyon ekranında kullanarak hesabına bakiye ekleyebilirsin.";
      rows = [["Kod", facts.coupon.code], ["Bakiye", money(facts.coupon.value)]];
      path = "/promosyonlar"; label = "Promosyon kodunu kullan";
      break;
    case "new_device":
      subject = "Hesabına yeni bir cihazdan giriş yapıldı";
      intro = "Bu girişi tanımıyorsan oturumlarını incele ve şifreni değiştir.";
      rows = [["Cihaz", job.data?.label], ["Giriş zamanı", date(job.createdAt)]];
      path = "/hesabim?bolum=sessions"; label = "Oturumlarımı incele";
      break;
    case "restock":
    case "stock":
      subject = job.type === "restock" ? "Beklediğin paket yeniden stokta" : "Takip ettiğin ürüne stok eklendi";
      intro = `${item} için stok yeniden kullanılabilir. Satın almadan önce güncel paket ve stok durumunu incele.`;
      path = "/urun/" + encodeURIComponent(facts.product.id) + (job.data?.planKey ? "?paket=" + encodeURIComponent(job.data?.planKey) : "");
      label = "Ürünü incele";
      break;
    case "price":
      subject = "Takip ettiğin paketin fiyatı düştü";
      intro = `${item} için takip ettiğin paket fiyatı güncellendi.`;
      rows = [
        ["Paket", facts.plan.label || facts.plan.key],
        ["Güncel fiyat", money(facts.plan.priceKurus)],
      ];
      if (facts.oldPriceKurus > facts.plan.priceKurus)
        rows.push(["Önceki kayıtlı fiyat", money(facts.oldPriceKurus)]);
      path =
        "/urun/" +
        encodeURIComponent(facts.product.id) +
        "?paket=" +
        encodeURIComponent(facts.plan.key);
      label = "Güncel fiyatı incele";
      break;
    case "license":
      subject = "Lisans süren yaklaşıyor";
      intro =
        "Siparişinde kayıtlı lisans bitiş tarihi yaklaşıyor. Kullanım bilgilerini hesabından inceleyebilirsin.";
      rows = [["Bitiş", date(facts.expiresAt)]];
      path = job.data?.orderId ? "/siparisler?order=" + encodeURIComponent(job.data.orderId) : "/siparisler";
      label = "Siparişlerimi görüntüle";
      break;
    case "order_created":
      subject = "Siparişini aldık · " + facts.order.orderNumber;
      intro =
        "Siparişin oluşturuldu. Ödeme ve teslimatın güncel durumunu hesabından takip edebilirsin.";
      rows = [
        ["Sipariş", facts.order.orderNumber],
        ["Tutar", money(facts.order.totalKurus)],
        ["Durum", facts.statusLabel],
      ];
      path = job.data?.orderId ? "/siparisler?order=" + encodeURIComponent(job.data.orderId) : "/siparisler";
      label = "Siparişimi görüntüle";
      break;
    case "paid_delivered":
      subject = "Ödemen onaylandı, ürünün teslim edildi";
      intro =
        "Siparişinin ödeme onayı ve dijital teslimatı tamamlandı. Teslimat bilgilerin hesabındaki korumalı alanda hazır.";
      rows = [
        ["Sipariş", facts.order.orderNumber],
        ["Ödenen tutar", money(facts.order.totalKurus)],
        ["Teslimat zamanı", date(facts.order.delivery.deliveredAt)],
      ];
      path = job.data?.orderId ? "/siparisler?order=" + encodeURIComponent(job.data.orderId) : "/siparisler";
      label = "Siparişimi görüntüle";
      break;
    case "gift_received":
      subject = "Zentra Store’da sana bir hediye var";
      intro =
        "Hesabına gönderilen dijital ürünün teslimatı hazır. Teslimat bilgilerini kendi hesabından görüntüleyebilirsin.";
      path = "/hesabim?bolum=gifts";
      label = "Hediyelerimi görüntüle";
      break;
    case "wallet_credit":
      subject = "Hesabına " + money(facts.amountKurus) + " bakiye eklendi";
      intro = "Bakiye işlemin hesabına kaydedildi.";
      rows = [
        ["Eklenen tutar", money(facts.amountKurus)],
        ["İşlem sonrası bakiye", money(facts.balanceAfterKurus)],
        ["İşlem zamanı", date(job.createdAt)],
      ];
      path = "/hesabim";
      label = "Güncel bakiyemi görüntüle";
      break;
    case "coupon_assigned":
      subject = facts.coupon.customerUids?.length ? "Hesabına özel indirim kodun hazır" : "Yeni indirim kuponu kullanıma açıldı";
      intro =
        "Kuponu geçerlilik süresi içinde uygun bir siparişte kullanabilirsin.";
      rows = [
        ["Kupon", facts.coupon.code],
        [
          "İndirim",
          facts.coupon.type === "percent"
            ? `%${facts.coupon.value}`
            : money(facts.coupon.value),
        ],
        ["Minimum sepet", money(facts.coupon.minimumSubtotalKurus || 0)],
        [
          "Geçerlilik",
          facts.coupon.endsAt
            ? date(facts.coupon.endsAt)
            : "Bitiş tarihi tanımlanmamış",
        ],
      ];
      path = "/kuponlar";
      label = "Kuponun koşullarını görüntüle";
      break;
    case "username_changed":
      subject = "Kullanıcı adın değiştirildi";
      intro =
        "Hesabının kullanıcı adı güncellendi. Bu işlemi sen yapmadıysan hesabının güvenlik ayarlarını kontrol et.";
      rows = [
        ["Önceki kullanıcı adı", job.data?.previous],
        ["Yeni kullanıcı adı", job.data?.current],
        ["İşlem zamanı", date(job.createdAt)],
      ];
      path = "/hesabim?bolum=sessions";
      label = "Hesap güvenliğini kontrol et";
      break;
    case "password_changed":
      subject = facts.reset ? "Hesabının şifresi sıfırlandı" : "Hesabının şifresi değiştirildi";
      intro =
        "Hesabının şifresi başarıyla değiştirildi. Bu işlemi sen yapmadıysan hesabını güvene al ve destek ekibiyle iletişime geç.";
      rows = [["İşlem zamanı", date(job.createdAt)]];
      path = "/hesabim?bolum=sessions";
      label = "Hesap güvenliğini kontrol et";
      break;
    case "test":
      subject = "ZENTRA STORE · E-posta bağlantı testi";
      intro =
        "Bu ileti, yönetim panelinde başlattığın gerçek e-posta gönderim testidir. Gönderim ve teslimat durumları yönetim panelinden ayrı ayrı takip edilir.";
      rows = [["İşlem zamanı", date(job.createdAt)]];
      break;
    default:
      throw Error("EMAIL_TEMPLATE_UNKNOWN");
  }
  if (facts.order?.items?.length)
    rows.push([
      "Ürünler",
      facts.order.items
        .map(
          (x) =>
            `${x.name || x.productName || x.productId} · ${x.planLabel || x.planKey} × ${x.quantity}`,
        )
        .join(" / ")
        .slice(0, 1200),
    ]);
  ({ subject, intro, label } = require("./editor").apply(template, { subject, intro, label }, {
    tarih: date(job.createdAt), urun: facts.product?.name, kod: facts.coupon?.code,
    kullanici: job.data?.current, cihaz: job.data?.label,
    tutar: Number.isSafeInteger(facts.amountKurus) ? money(facts.amountKurus) : undefined
  }));
  const href = storeEntryUrl(config.origin, path);
  const logo = new URL("/public/assets/images/logo.png", config.origin).href;
  const token = OPTIONAL[job.category]
    ? unsubscribeToken(job.uid, job.category)
    : "";
  const unsubscribe = token
    ? new URL(
        "/email/unsubscribe?token=" + encodeURIComponent(token),
        config.backend,
      ).href
    : "";
  const footer = unsubscribe
    ? `<p style="font-size:12px;color:#4b5563"><a href="${escape(unsubscribe)}" style="color:#263e9c">Bu tür e-postaları kapat</a></p>`
    : '<p style="font-size:12px;color:#4b5563">Bu ileti hesabınla ilişkili bir işlem hakkında gönderilmiştir.</p>';
  const html = `<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width, initial-scale=0.85, viewport-fit=cover" /><meta charset="utf-8"><title>${escape(subject)}</title></head><body style="margin:0;background:#f4f6fb;color:#14213b;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:20px"><tr><td style="padding:28px"><img src="${escape(logo)}" alt="ZENTRA STORE" width="64" height="64" style="display:block;border-radius:14px"><p style="font-size:13px;font-weight:bold;letter-spacing:2px;color:#334ca5">ZENTRA STORE</p><h1 style="font-size:26px;line-height:1.25;margin:20px 0">${escape(subject)}</h1><p style="font-size:16px;line-height:1.7">${escape(intro).replaceAll("\n","<br>")}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.map(([key, value]) => `<tr><td style="padding:12px 0;border-bottom:1px solid #e6eaf2;font-size:14px;vertical-align:top;width:38%">${escape(key)}</td><td style="padding:12px 0 12px 12px;border-bottom:1px solid #e6eaf2;font-size:14px;overflow-wrap:anywhere">${escape(value)}</td></tr>`).join("")}</table><p style="margin:28px 0"><a href="${escape(href)}" style="display:inline-block;background:#263e9c;color:#fff;padding:16px 22px;border-radius:12px;text-decoration:none;font-weight:bold">${escape(label)}</a></p><p style="font-size:12px;line-height:1.6;color:#4b5563">İşlem anındaki bilgileri içerir. Güncel durum ve kullanım koşulları hesabında gösterilir.</p>${footer}</td></tr></table></td></tr></table></body></html>`;
  const text = [
    "ZENTRA STORE",
    subject,
    intro,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    `${label}: ${href}`,
    unsubscribe
      ? `Bu tür e-postaları kapat: ${unsubscribe}`
      : "Bu ileti hesabınla ilişkili bir işlem hakkındadır.",
  ].join("\n\n");
  return {
    from: config.from,
    to: [recipient],
    subject,
    html,
    text,
    ...(config.replyTo ? { reply_to: config.replyTo } : {}),
    ...(unsubscribe
      ? {
          headers: {
            "List-Unsubscribe": `<${unsubscribe}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : {}),
    tags: [{ name: "zentra_event", value: job.id }],
  };
}
module.exports = { render, TYPES, escape };
