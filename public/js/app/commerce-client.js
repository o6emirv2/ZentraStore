import {
  escape as e,
  money,
  date,
  icon,
  modal,
  toast,
  field,
  busy,
  status,
  copyText,
} from "./ui.js?v=109";
import {
  applyPreferences,
  displayPreferences,
  tr,
  translate,
} from "./preferences.mjs?v=109";
const BASE = "/api/store/commerce";
const button = (action, label, id = "", extra = "") =>
  `<button type="button" class="button secondary small" data-commerce="${e(action)}" data-id="${e(id)}" ${extra}>${e(label)}</button>`;
const select = (name, label, options, value = "") => {
  const id = "select-" + crypto.randomUUID();
  return `<div class="field"><label for="${id}">${e(label)}</label><select id="${id}" name="${e(name)}">${options.map(([k, v]) => `<option value="${e(k)}" ${String(k) === String(value) ? "selected" : ""}>${e(v)}</option>`).join("")}</select></div>`;
};
const check = (name, label, value) =>
  `<label class="checkbox"><input type="checkbox" name="${e(name)}" ${value ? "checked" : ""}>${e(label)}</label>`;
const area = (name, label, value = "", max = 4000) =>
  `<label class="field"><span>${e(label)}</span><textarea name="${e(name)}" maxlength="${max}" required>${e(value)}</textarea></label>`;
const panel = (title, body) =>
  `<section class="panel commerce-panel"><h2>${e(title)}</h2>${body}</section>`;
const brandAppearance = () =>
  `<input type="hidden" name="theme" value="dark"><p class="fine-print">${tr("Mağaza koyu lacivert Zentra tasarımıyla görüntülenir.", "The store uses the navy Zentra appearance.")}</p>`;
export function createCommerceClient({
  api,
  userId,
  deviceMarker = () => ({}),
  cart,
  getFavorites,
  setFavorites,
  getProduct,
  navigate,
  refresh,
  logout,
}) {
  let profile = null,
    owner = "",
    epoch = 0,
    connecting = null,
    mutations = Promise.resolve(),
    saving = Promise.resolve();
  const metadata = new Map(),
    confirmations = new Set();
  const confirmResult = (resolve) => {
    const done = (value) => {
      confirmations.delete(done);
      resolve(value);
    };
    confirmations.add(done);
    return done;
  };
  async function call(path, options = {}) {
    const uid = userId();
    const r = await api(BASE + path, options);
    if (options.auth !== false && uid !== userId())
      throw new Error(tr("Oturum değişti.", "Your session changed."));
    return r.result;
  }
  function connect(uid) {
    if (owner === uid && profile) return Promise.resolve();
    if (owner === uid && connecting) return connecting;
    const pending = loadProfile(uid);
    connecting = pending;
    return pending.finally(() => {
      if (connecting === pending) connecting = null;
    });
  }
  async function loadProfile(uid) {
    for (const done of confirmations) done(false);
    const generation = ++epoch;
    owner = uid;
    profile = null;
    cart.owner(uid);
    setFavorites([]);
    if (!uid) return;
    const data = await call("/profile");
    if (generation !== epoch || uid !== userId()) return;
    profile = data;
    cart.replace(data.cart);
    setFavorites(data.favorites);
    applyPreferences(data.preferences);
    let deviceId;
    try {
      deviceId = localStorage.getItem("zentra-device-id");
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        localStorage.setItem("zentra-device-id", deviceId);
      }
    } catch {
      deviceId = crypto.randomUUID();
    }
    const label = /iPhone|iPad/i.test(navigator.userAgent)
      ? "iPhone / iPad"
      : /Android/i.test(navigator.userAgent)
        ? "Android"
        : "Web tarayıcısı";
    await call("/sessions", { body: { deviceId, label, ...deviceMarker() } });
    if (generation !== epoch) return;
    refresh();
  }
  async function ready() {
    const uid = userId();
    if (!uid)
      throw new Error(
        tr(
          "Sepeti güncellemek için giriş yap.",
          "Sign in to update your cart.",
        ),
      );
    await connect(uid);
    if (uid !== userId() || uid !== owner || !profile)
      throw new Error(tr("Oturum değişti.", "Your session changed."));
  }
  function changeCart(change) {
    const uid = userId();
    const operation = mutations
      .catch(() => {})
      .then(async () => {
        if (!uid || uid !== userId())
          throw new Error(tr("Oturum değişti.", "Your session changed."));
        await ready();
        change();
        return saveCart();
      });
    mutations = operation;
    return operation;
  }
  function save(change) {
    const uid = userId(),
      generation = epoch;
    const operation = saving
      .catch(() => {})
      .then(async () => {
        if (!uid || uid !== owner || generation !== epoch)
          throw new Error(
            tr(
              "Sepeti güncellemek için giriş yap.",
              "Sign in to update your cart.",
            ),
          );
        if (!profile)
          throw new Error(
            tr(
              "Hesap sepeti henüz yüklenmedi. Kısa süre sonra yeniden dene.",
              "Your account cart is still loading. Please try again shortly.",
            ),
          );
        try {
          profile = await call("/profile", {
            method: "PATCH",
            body: { expectedRevision: profile.revision, ...change },
          });
        } catch (error) {
          if (error.code === "COMMERCE_REVISION_CONFLICT") {
            profile = await call("/profile");
            cart.replace(profile.cart);
            setFavorites(profile.favorites);
            refresh();
            throw new Error(
              tr(
                "Sepetin başka bir cihazda değişti. Güncel sepet yüklendi; işlemini yeniden seç.",
                "Your cart changed on another device. Review the latest cart and try again.",
              ),
            );
          }
          throw error;
        }
        if (generation !== epoch) return;
        cart.replace(profile.cart);
        setFavorites(profile.favorites);
        applyPreferences(profile.preferences);
        return profile;
      });
    saving = operation;
    return operation;
  }
  async function saveCart() {
    const previous = profile?.cart || [];
    const items = cart.items().map((x) => ({
      ...x,
      acceptedUnitPriceKurus:
        previous.find(
          (i) => i.productId === x.productId && i.planKey === x.planKey,
        )?.acceptedUnitPriceKurus ??
        getProduct(x.productId)?.plans.find((p) => p.key === x.planKey)
          ?.priceKurus,
    }));
    try {
      return await save({ cart: items });
    } catch (error) {
      cart.replace(profile?.cart || []);
      refresh();
      throw error;
    }
  }
  async function saveFavorites() {
    const values = [...getFavorites()];
    try {
      return await save({ favorites: values });
    } catch (error) {
      setFavorites(profile?.favorites || []);
      refresh();
      throw error;
    }
  }
  const accountLinks = () =>
    `<div class="commerce-shortcuts">${[
      ["support", "Destek taleplerim", "My support tickets"],
      ["requests", "Taleplerim", "My requests"],
      ["gifts", "Hediyelerim", "My gifts"],
      ["loyalty", "Zentra puanlarım", "My Zentra points"],
      ["sessions", "Oturumlarım", "My sessions"],
      ["preferences", "Görünüm ve bildirimler", "Display and notifications"],
      ["privacy", "Verilerim ve gizlilik", "My data and privacy"],
    ]
      .map(
        ([id, t, en]) =>
          `<a href="/hesabim?bolum=${id}" data-nav>${icon({ support: "support", requests: "receipt", gifts: "gift", loyalty: "sparkles", sessions: "phone", preferences: "settings", privacy: "shield" }[id])}<span>${e(tr(t, en))}</span>${icon("chevron")}</a>`,
      )
      .join("")}</div>`;
  function preferenceForm(p) {
    return `<form id="commerce-preferences">${brandAppearance()}${select(
      "language",
      tr("Dil", "Language"),
      [
        ["tr", "Türkçe"],
        ["en", "English"],
      ],
      p.language,
    )}${select(
      "textScale",
      tr("Metin boyutu", "Text size"),
      [
        [100, "100%"],
        [115, "115%"],
        [130, "130%"],
        [150, "150%"],
        [200, "200%"],
      ],
      p.textScale,
    )}${check("highContrast", tr("Yüksek kontrast", "High contrast"), p.highContrast)}${check("reducedMotion", tr("Hareketi azalt", "Reduce motion"), p.reducedMotion)}${check("stockNotifications", tr("Stok bildirimlerini aç", "Enable stock notifications"), p.stockNotifications)}${check("priceNotifications", tr("Fiyat bildirimlerini aç", "Enable price notifications"), p.priceNotifications)}${check("licenseReminders", tr("Lisans hatırlatmalarını aç", "Enable license reminders"), p.licenseReminders)}<fieldset><legend>${tr("E-posta bildirimleri", "Email notifications")}</legend><p class="fine-print">${tr("E-postalar doğrulanmış hesap adresine gönderilir. Stok ve fiyat bildirimleri takip ettiğin ürünler için geçerlidir.", "Emails go to your verified account address. Stock and price alerts apply to products you follow.")}</p>${check("emailStockNotifications", tr("Stok geldiğinde e-posta gönder", "Email me when stock returns"), p.emailStockNotifications)}${check("emailPriceNotifications", tr("Fiyat düştüğünde e-posta gönder", "Email me about price drops"), p.emailPriceNotifications)}${check("emailLicenseReminders", tr("Lisans bitişini e-postayla hatırlat", "Email license reminders"), p.emailLicenseReminders)}${check("emailCouponNotifications", tr("Hesabıma özel kuponları e-postayla bildir", "Email my assigned coupons"), p.emailCouponNotifications)}${check("emailOrderNotifications", tr("Sipariş ve teslimat e-postaları", "Order and delivery emails"), p.emailOrderNotifications !== false)}${check("emailWalletNotifications", tr("Bakiye ekleme e-postaları", "Wallet credit emails"), p.emailWalletNotifications !== false)}<p class="fine-print">${tr("Şifre ve kullanıcı adı değişiklikleri güvenlik bildirimi olarak gönderilir.", "Password and username changes generate security notices.")}</p></fieldset><button type="submit" class="button primary">${tr("Tercihleri kaydet", "Save preferences")}</button></form>`;
  }
  async function accountSection(section) {
    const title = {
      support: tr("Destek taleplerim", "My support tickets"),
      requests: tr("Taleplerim", "My requests"),
      gifts: tr("Hediyelerim", "My gifts"),
      loyalty: tr("Zentra puanlarım", "My Zentra points"),
      sessions: tr("Aktif oturumlar", "Active sessions"),
      preferences: tr("Görünüm ve bildirimler", "Display and notifications"),
      privacy: tr("Verilerim ve gizlilik", "My data and privacy"),
    }[section];
    if (!title) return "";
    let body = "";
    if (section === "preferences") {
      profile = await call("/profile");
      body = preferenceForm(profile.preferences);
    }
    if (section === "support") {
      const r = await call("/tickets");
      body =
        button("ticket-new", tr("Yeni destek talebi", "New support ticket")) +
        r.items
          .map(
            (x) =>
              `<article class="commerce-row"><div><h3>${e(x.subject)}</h3><p>${e(x.orderNumber)} · ${e(x.status)} · ${date(x.updatedAt)}</p></div>${button("ticket", tr("Görüşmeyi aç", "Open conversation"), x.id)}</article>`,
          )
          .join("");
      if (!r.items.length)
        body += `<p>${tr("Henüz destek talebin yok.", "You have no support tickets yet.")}</p>`;
      if (r.nextCursor)
        body += button(
          "more-tickets",
          tr("Daha fazla", "Load more"),
          r.nextCursor,
        );
    }
    if (section === "requests") {
      const r = await call("/requests");
      body =
        button("request-product", tr("Ürün öner", "Request a product")) +
        r.items
          .map(
            (x) =>
              `<article class="commerce-row"><div><h3>${e(x.subject)}</h3><p>${e(x.kind)} · ${e(x.status)} · ${date(x.createdAt)}</p><p data-user-content>${e(x.reply || x.message)}</p></div></article>`,
          )
          .join("");
    }
    if (section === "gifts") {
      const r = await call("/gifts");
      body =
        r.items
          .map(
            (x) =>
              `<article class="commerce-row"><div><h3>${e(x.orderNumber)}</h3>${status(x.status)}<p>${x.items.map((i) => e(i.productName) + " · " + e(i.planLabel)).join("<br>")}</p></div>${x.deliveryReady ? button("gift-delivery", tr("Teslimatı aç", "Open delivery"), x.id) : ""}${button("order", tr("Sipariş adımları", "Order timeline"), x.id)}</article>`,
          )
          .join("") ||
        `<p>${tr("Hesabına gönderilen hediyeler burada görünür.", "Gifts sent to your account appear here.")}</p>`;
    }
    if (section === "loyalty") {
      const r = await call("/loyalty");
      body = r.enabled
        ? `<p class="commerce-number">${e(r.balance)} <small>${tr("puan", "points")}</small></p><p>${e(r.rewardPoints)} ${tr("puan ile", "points for")} ${money(r.rewardDiscountKurus)} · ${tr("Minimum sepet", "Minimum subtotal")}: ${money(r.minimumSubtotalKurus)}</p>${button("redeem-points", tr("Puanları kupona çevir", "Redeem points"), "", r.balance < r.rewardPoints ? "disabled" : "")}<p class="fine-print">${tr("Puanlar doğrulanmış ödemelerden hesaplanır; iptal ve iade durumunda geri alınır. İncelenen son sipariş sayısı:", "Points come from confirmed payments and are reversed on cancellation or refund. Recent orders analyzed:")} ${r.scope.ordersAnalyzed}/${r.scope.limit}</p>`
        : `<p>${tr("Sadakat programı henüz etkinleştirilmedi.", "The loyalty program is not enabled yet.")}</p>`;
    }
    if (section === "sessions") {
      const r = await call("/sessions");
      body =
        `<p class="fine-print">${tr("Bu liste doğrulanmış son tarayıcı kayıtlarını gösterir; anlık çevrimiçi sayacı değildir. Tüm oturumları kapattığında bu cihazdan da yeniden giriş yapman gerekir.", "These are recent verified browser records, not a live online counter. Revoking all sessions also requires signing in on this device.")}</p>` +
        r
          .map(
            (x) =>
              `<article class="commerce-row"><div><h3>${e(x.label)}</h3><p>${date(x.lastSeenAt)} · ${x.revokedAt ? tr("Sonlandırıldı", "Revoked") : tr("Son erişim", "Last access")}</p></div></article>`,
          )
          .join("") +
        button(
          "revoke-sessions",
          tr("Tüm cihazlardan çıkış yap", "Sign out of all devices"),
        );
    }
    if (section === "privacy")
      body = `<p>${tr("Hesap ve sipariş verilerini JSON olarak indirebilir veya veri talebi açabilirsin. Finansal ve denetim kayıtları saklama politikası gereği otomatik silinmez. Hassas işlemler yakın zamanda giriş yapılmasını gerektirir.", "Download your account and orders as JSON or submit a data request. Financial and audit records are retained under the retention policy. Sensitive actions require a recent sign-in.")}</p>${button("export", tr("Verilerimi indir", "Download my data"))}${button("data-request", tr("Veri talebi oluştur", "Submit data request"))}`;
    if (section === "privacy") {
      const r = await call("/data-requests");
      body += r.items
        .map(
          (x) =>
            `<article class="commerce-row"><div><h3>${e(x.kind)} · ${e(x.status)}</h3><p>${date(x.createdAt)}</p><p data-user-content>${e(x.reply || x.message)}</p></div></article>`,
        )
        .join("");
    }
    return `<a class="section-link" href="/hesabim" data-nav>${icon("back")}${tr("Hesabıma dön", "Back to my account")}</a><header class="page-heading"><h1>${e(title)}</h1></header>${panel(title, body)}`;
  }
  async function productInfo(id) {
    const cached = metadata.get(id);
    if (cached?.until > Date.now()) return cached.value;
    const value = await call("/products/" + encodeURIComponent(id), {
      auth: false,
    });
    metadata.set(id, { value, until: Date.now() + 60000 });
    return value;
  }
  function productExtras(p, info, planKey) {
    if (!info)
      return `<div class="commerce-product-actions">${button("compare", tr("Paket karşılaştırması", "Compare packages"), p.id)}${button("share", tr("Paket bağlantısını paylaş", "Share package link"), p.id, `data-plan="${e(planKey)}"`)}</div><div class="notice">${tr("Ek ürün bilgileri şu anda doğrulanamadı.", "Additional product details could not be verified.")}</div>`;
    const meta = info.product || {},
      lang = document.documentElement.lang,
      description = meta.description?.[lang] || meta.description?.tr,
      requirements = meta.requirements?.[lang] || meta.requirements?.tr;
    const guide = meta.guide?.[lang] || meta.guide?.tr;
    return `${guide ? panel(tr("Kurulum açıklaması", "Setup instructions"), `<p data-user-content>${e(guide)}</p>`) : ""}<div class="commerce-product-actions">${button("compare", tr("Paket karşılaştırması", "Compare packages"), p.id)}${button("share", tr("Paket bağlantısını paylaş", "Share package link"), p.id, `data-plan="${e(planKey)}"`)}${button("watch", tr("Takip ve bildirimler", "Product notifications"), p.id)}</div>${description ? `<p class="detail-description" data-user-content>${e(description)}</p>` : ""}${requirements ? panel(tr("Gereksinimler", "Requirements"), `<p data-user-content>${e(requirements)}</p>`) : ""}<div class="commerce-info-grid">${panel(
      tr("Sürüm ve teslimat", "Version and delivery"),
      `<p>${tr("Güncel sürüm", "Current version")}: <b>${e(meta.version || tr("Yayıncı belirtmedi", "Not supplied by publisher"))}</b></p><p>${e(meta.deliveryEstimate || (p.fulfillmentMode === "telegram_only" ? tr("Destek ekibi üzerinden teslimat", "Delivery through support") : tr("Doğrulanmış stok ve bakiye ile otomatik teslimat", "Automatic delivery with verified stock and balance")))}</p>${(
        meta.releaseNotes || []
      )
        .slice(0, 5)
        .map(
          (x) =>
            `<details><summary>${e(x.version)} · ${date(x.publishedAt)}</summary><p data-user-content>${e(x.message)}</p></details>`,
        )
        .join("")}`,
    )}${panel(tr("Gerçek fiyat geçmişi", "Recorded price history"), info.priceHistory.length ? `<div class="commerce-table-wrap"><table><thead><tr><th>${tr("Paket", "Package")}</th><th>${tr("Fiyat", "Price")}</th><th>${tr("Tarih", "Date")}</th></tr></thead><tbody>${info.priceHistory.map((x) => `<tr><td>${e(x.planKey)}</td><td>${money(x.priceKurus)}</td><td>${date(x.createdAt)}</td></tr>`).join("")}</tbody></table></div>` : `<p>${tr("Önceki fiyat kayıtları oluşturulmadı.", "No earlier prices have been recorded.")}</p>`)}</div>`;
  }
  function comparison(p) {
    modal({
      title: tr("Paket karşılaştırması", "Package comparison"),
      body: `<div class="comparison-cards">${p.plans.map((x) => `<article class="comparison-card"><header><h3>${e(x.label)}</h3><strong>${money(x.priceKurus)}</strong></header><dl><div><dt>${tr("Süre", "Duration")}</dt><dd>${e(x.duration)}</dd></div><div><dt>${tr("Teslimat", "Delivery")}</dt><dd>${p.fulfillmentMode === "telegram_only" ? "Telegram" : tr("Stok doğrulaması", "Stock verification")}</dd></div></dl></article>`).join("")}</div><div class="commerce-table-wrap comparison-desktop"><table><thead><tr><th>${tr("Paket", "Package")}</th><th>${tr("Süre", "Duration")}</th><th>${tr("Fiyat", "Price")}</th><th>${tr("Teslimat", "Delivery")}</th></tr></thead><tbody>${p.plans.map((x) => `<tr><td>${e(x.label)}</td><td>${e(x.duration)}</td><td>${money(x.priceKurus)}</td><td>${p.fulfillmentMode === "telegram_only" ? "Telegram" : tr("Stok doğrulaması", "Stock verification")}</td></tr>`).join("")}</tbody></table></div><p class="fine-print">${tr("Paket özellikleri ürün açıklamasındaki yayıncı bilgilerine bağlıdır.", "Package features follow the publisher details in the product description.")}</p>`,
    });
  }
  async function confirmCompatibility(p, key) {
    const match = /iPhone|iPad|iPod/i.test(navigator.userAgent)
      ? "ios"
      : /Android/i.test(navigator.userAgent)
        ? "android"
        : "";
    const info = await call(
        "/products/" + encodeURIComponent(p.id) + "/compatibility",
        { auth: false },
      ),
      requirements =
        info.requirements?.[document.documentElement.lang] ||
        info.requirements?.tr ||
        "";
    if (info.productId !== p.id || info.platform !== p.platform)
      throw new Error(
        tr(
          "Ürün uyumluluğu doğrulanamadı.",
          "Product compatibility could not be verified.",
        ),
      );
    return new Promise((resolve) => {
      resolve = confirmResult(resolve);
      const dialog = modal({
        title: tr("Uyumluluğunu kontrol et", "Check compatibility"),
        body: `<p><b>${e(p.name)} · ${e(p.plans.find((x) => x.key === key)?.label || key)}</b></p><p>${tr("Bu paket", "This package is for")} <b>${p.platform === "ios" ? "iOS" : "Android"}</b>.</p>${match && match !== p.platform ? `<div class="notice">${tr("Kullandığın cihaz farklı bir platformda görünüyor. Satın alacağın cihazı kontrol et.", "Your current device appears to use a different platform. Check the intended device.")}</div>` : ""}${requirements ? `<p data-user-content>${e(requirements)}</p>` : ""}${check("compatible", tr("Platform ve gereksinimleri kontrol ettim.", "I checked the platform and requirements."), false)}`,
        submit: tr("Sepete ekle", "Add to cart"),
        onSubmit: (data) => {
          if (!data.has("compatible"))
            throw new Error(
              tr(
                "Devam etmek için uyumluluğu onayla.",
                "Confirm compatibility to continue.",
              ),
            );
          resolve(true);
        },
      });
      dialog.element.addEventListener("close", () => resolve(false), {
        once: true,
      });
    });
  }
  async function checkoutQuote(lines, method, promotionCode = "") {
    await mutations.catch(() => {});
    await ready();
    let giftRecipientUid = "";
    const target = document
      .querySelector("#commerce-gift-recipient")
      ?.value.trim();
    if (target) {
      const recipient = await call("/recipient", {
        body: { username: target },
      });
      giftRecipientUid = recipient.uid;
    }
    const quote = await call("/quote", {
      body: {
        items: lines.map((x) => ({
          productId: x.productId,
          planKey: x.planKey,
          quantity: x.quantity,
          expectedUnitPriceKurus:
            profile?.cart.find(
              (i) => i.productId === x.productId && i.planKey === x.planKey,
            )?.acceptedUnitPriceKurus ?? x.plan.priceKurus,
        })),
        paymentMethod: method,
        promotionCode,
        ...(giftRecipientUid ? { giftRecipientUid } : {}),
      },
    });
    const accepted = await new Promise((resolve) => {
      resolve = confirmResult(resolve);
      const dialog = modal({
        title: quote.changes.length
          ? tr("Fiyat güncellendi", "Price updated")
          : tr("Siparişi onayla", "Confirm order"),
        body: `${quote.changes.map((x) => `<p>${e(getProduct(x.productId)?.name)} · ${money(x.previousUnitPriceKurus)} → <b>${money(x.unitPriceKurus)}</b></p>`).join("")}<p>${tr("Doğrulanmış toplam", "Verified total")}: <b>${money(quote.totalKurus)}</b></p>${giftRecipientUid ? `<p>${tr("Hediye alıcısı", "Gift recipient")}: ${e(target)}</p>` : ""}<p class="fine-print">${tr("Fiyat teklifi 5 dakika geçerlidir. Son aşamada fiyat ve stok yeniden doğrulanır.", "This quote is valid for 5 minutes. Price and stock are checked again when you submit.")}</p>`,
        submit: tr("Onaylıyorum", "Confirm"),
        onSubmit: () => resolve(true),
      });
      dialog.element.addEventListener("close", () => resolve(false), {
        once: true,
      });
    });
    if (!accepted) return null;
    const reservation =
      method === "wallet"
        ? await call("/reservations", { body: { quoteToken: quote.token } })
        : null;
    return { quote, reservation };
  }
  async function ticketDialog(id) {
    const ticket = await call("/tickets/" + encodeURIComponent(id));
    modal({
      title: ticket.subject,
      body: `<p>${e(ticket.orderNumber)} · ${e(ticket.status)}</p><div class="commerce-messages">${ticket.messages.map((m) => `<article class="commerce-message ${m.role === "staff" ? "staff" : ""}"><small>${m.role === "staff" ? tr("Zentra destek", "Zentra support") : tr("Sen", "You")} · ${date(m.createdAt)}</small><p data-user-content>${e(m.message)}</p></article>`).join("")}</div>${area("message", tr("Yanıtın", "Your reply"))}${ticket.status === "resolved" && !ticket.satisfaction ? button("rate-ticket", tr("Desteği değerlendir", "Rate support"), id) : ""}`,
      submit: tr("Yanıtı gönder", "Send reply"),
      onSubmit: async (data) => {
        await call("/tickets/" + id + "/reply", {
          body: {
            expectedRevision: ticket.revision,
            message: data.get("message"),
          },
        });
        toast(tr("Yanıtın kaydedildi.", "Your reply was saved."));
        refresh();
      },
    });
  }
  function requestDialog(kind, orderId = "") {
    const requestKey = crypto.randomUUID();
    modal({
      title:
        kind === "product"
          ? tr("Ürün talebi", "Product request")
          : tr("Sipariş talebi", "Order request"),
      body: `${
        kind !== "product"
          ? select(
              "kind",
              tr("Talep türü", "Request type"),
              [
                ["refund", tr("İade", "Refund")],
                ["cancellation", tr("İptal", "Cancellation")],
              ],
              kind,
            )
          : ""
      }${field("subject", tr("Konu", "Subject"), "text", "", 'required maxlength="120"')}${area("message", tr("Açıklama", "Description"))}`,
      submit: tr("Talebi gönder", "Submit request"),
      onSubmit: async (data) => {
        await call("/requests", {
          body: {
            kind: kind === "product" ? kind : data.get("kind"),
            orderId,
            subject: data.get("subject"),
            message: data.get("message"),
            idempotencyKey: requestKey,
          },
        });
        toast(
          tr(
            "Talebin kaydedildi. Ödeme/iade henüz tamamlanmadı.",
            "Your request was saved. No payment or refund has been completed.",
          ),
        );
        refresh();
      },
    });
  }
  async function orderDialog(id, { isCurrent = () => true } = {}) {
    const r = await call("/orders/" + encodeURIComponent(id));
    if (!isCurrent()) return;
    return modal({
      title: tr("Sipariş adımları", "Order timeline"),
      body: `${status(r.status)}<p>${tr("Ödeme", "Payment")}: ${e(r.paymentStatus)}</p><ol class="commerce-timeline">${r.timeline.map((x) => `<li><b>${e(x.status)}</b><time>${date(x.createdAt)}</time></li>`).join("")}</ol>${r.license ? `<p>${tr("Doğrulanmış lisans süresi", "Verified license period")}: ${date(r.license.startsAt)} — ${date(r.license.expiresAt)}<br><small data-user-content>${e(r.license.source)}</small></p>` : `<p class="fine-print">${tr("Lisans bitiş tarihi henüz doğrulanmadı.", "License expiry has not been verified yet.")}</p>`}<p>${tr("Teslimat açıldı", "Delivery viewed")}: ${date(r.delivery.viewedAt)}<br>${tr("Teslim alındı onayı", "Delivery acknowledgement")}: ${date(r.delivery.acknowledgedAt)}</p>${r.status === "delivered" ? button("acknowledge", tr("Teslim aldım", "Acknowledge delivery"), id) : ""}${button("ticket-new", tr("Destek talebi aç", "Open support ticket"), id)}${r.payer ? button("request-order", tr("İade / iptal talebi", "Refund / cancellation request"), id) : ""}`,
    });
  }
  function download(name, text, type = "application/json") {
    const url = URL.createObjectURL(new Blob([text], { type })),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function action(el) {
    const actionKey = el.dataset.operationKey || crypto.randomUUID();
    el.dataset.operationKey = actionKey;
    const a = el.dataset.commerce,
      id = el.dataset.id;
    busy(el, true);
    try {
      if (a === "display")
        return modal({
          title: tr("Görünüm ve erişilebilirlik", "Display and accessibility"),
          body:
            brandAppearance() +
            select(
              "language",
              tr("Dil", "Language"),
              [
                ["tr", "Türkçe"],
                ["en", "English"],
              ],
              displayPreferences().language,
            ) +
            select(
              "textScale",
              tr("Metin boyutu", "Text size"),
              [
                [100, "100%"],
                [115, "115%"],
                [130, "130%"],
                [150, "150%"],
                [200, "200%"],
              ],
              displayPreferences().textScale,
            ) +
            check(
              "highContrast",
              tr("Yüksek kontrast", "High contrast"),
              displayPreferences().highContrast,
            ) +
            check(
              "reducedMotion",
              tr("Hareketi azalt", "Reduce motion"),
              displayPreferences().reducedMotion,
            ),
          onSubmit: async (data) => {
            const preferences = {
              theme: data.get("theme"),
              language: data.get("language"),
              textScale: Number(data.get("textScale")),
              highContrast: data.has("highContrast"),
              reducedMotion: data.has("reducedMotion"),
            };
            if (userId()) await save({ preferences });
            else applyPreferences(preferences);
            refresh();
          },
        });
      if (a === "compare") return comparison(getProduct(id));
      if (a === "share") {
        const url = new URL("/urun/" + encodeURIComponent(id), location.origin);
        url.searchParams.set("paket", el.dataset.plan);
        if (navigator.share)
          await navigator.share({
            title: getProduct(id)?.name || "Zentra Store",
            url: url.href,
          });
        else await copyText(url.href);
        return;
      }
      if (!userId()) {
        navigate(
          "/hesabim?auth=login&next=" +
            encodeURIComponent(location.pathname + location.search),
        );
        return;
      }
      if (a === "watch") {
        const watches = await call("/watches"),
          watch = watches.find((x) => x.productId === id) || {};
        return modal({
          title: tr("Takip ve bildirimler", "Product notifications"),
          body:
            check(
              "stock",
              tr("Stok geldiğinde bildir", "Notify when in stock"),
              watch.stock,
            ) +
            check(
              "price",
              tr("Fiyat düştüğünde bildir", "Notify on price drop"),
              watch.price,
            ),
          onSubmit: async (data) => {
            await call("/watch", {
              body: {
                productId: id,
                stock: data.has("stock"),
                price: data.has("price"),
              },
            });
            await save({
              preferences: {
                stockNotifications:
                  data.has("stock") || profile?.preferences.stockNotifications,
                priceNotifications:
                  data.has("price") || profile?.preferences.priceNotifications,
              },
            });
            toast(
              tr(
                "Bildirim tercihlerin kaydedildi.",
                "Notification preferences saved.",
              ),
            );
          },
        });
      }
      if (a === "ticket") return await ticketDialog(id);
      if (a === "more-tickets") {
        const r = await call("/tickets?cursor=" + encodeURIComponent(id));
        return modal({
          title: tr("Destek talepleri", "Support tickets"),
          body:
            r.items
              .map(
                (x) =>
                  `<p>${e(x.subject)} ${button("ticket", tr("Aç", "Open"), x.id)}</p>`,
              )
              .join("") +
            (r.nextCursor
              ? button(
                  "more-tickets",
                  tr("Daha fazla", "Load more"),
                  r.nextCursor,
                )
              : ""),
        });
      }
      if (a === "ticket-new")
        return modal({
          title: tr("Sipariş desteği", "Order support"),
          body:
            (id
              ? `<input type="hidden" name="orderId" value="${e(id)}">`
              : field(
                  "orderId",
                  tr("Sipariş kimliği", "Order ID"),
                  "text",
                  "",
                  'required maxlength="128"',
                )) +
            field(
              "subject",
              tr("Konu", "Subject"),
              "text",
              "",
              'required maxlength="120"',
            ) +
            area("message", tr("Mesajın", "Your message")),
          submit: tr("Talebi oluştur", "Create ticket"),
          onSubmit: async (data) => {
            await call("/tickets", {
              body: {
                orderId: data.get("orderId"),
                subject: data.get("subject"),
                message: data.get("message"),
                idempotencyKey: actionKey,
              },
            });
            toast(tr("Destek talebin oluşturuldu.", "Support ticket created."));
            refresh();
          },
        });
      if (a === "rate-ticket")
        return modal({
          title: tr("Desteği değerlendir", "Rate support"),
          body:
            select(
              "rating",
              tr("Puan", "Rating"),
              [5, 4, 3, 2, 1].map((x) => [x, x + "/5"]),
              5,
            ) +
            field(
              "message",
              tr("Yorumun", "Your feedback"),
              "text",
              "",
              'maxlength="1000"',
            ),
          onSubmit: async (data) => {
            await call("/tickets/" + id + "/rating", {
              body: {
                rating: Number(data.get("rating")),
                message: data.get("message"),
              },
            });
            toast(tr("Değerlendirmen kaydedildi.", "Your rating was saved."));
            refresh();
          },
        });
      if (a === "request-product") return requestDialog("product");
      if (a === "request-order") return requestDialog("refund", id);
      if (a === "order") return await orderDialog(id);
      if (a === "acknowledge") {
        await call("/orders/" + id + "/acknowledge", { body: {} });
        toast(
          tr(
            "Teslim alındı onayın kaydedildi.",
            "Delivery acknowledgement saved.",
          ),
        );
        return;
      }
      if (a === "redeem-points") {
        const r = await call("/loyalty/redeem", {
          body: { idempotencyKey: actionKey },
        });
        modal({
          title: tr("Kuponun hazır", "Your coupon is ready"),
          body: `<code>${e(r.code)}</code><p>${e(r.points)} ${tr("puan kullanıldı.", "points redeemed.")}</p>`,
        });
        refresh();
        return;
      }
      if (a === "revoke-sessions")
        return modal({
          title: tr("Tüm oturumları sonlandır", "Revoke all sessions"),
          body: `<p>${tr("Bu cihaz dahil yeniden giriş yapılması gerekecek.", "You will need to sign in again on every device, including this one.")}</p>`,
          submit: tr("Oturumları sonlandır", "Revoke sessions"),
          danger: true,
          onSubmit: async () => {
            await call("/sessions/revoke", { body: {} });
            await logout();
            navigate("/hesabim");
          },
        });
      if (a === "export") {
        download(
          "zentra-hesap-verileri.json",
          JSON.stringify(await call("/export"), null, 2),
        );
        return;
      }
      if (a === "data-request")
        return modal({
          title: tr("Veri talebi", "Data request"),
          body:
            select(
              "kind",
              tr("Talep türü", "Request type"),
              [
                ["access", tr("Erişim", "Access")],
                ["correction", tr("Düzeltme", "Correction")],
                ["deletion", tr("Silme incelemesi", "Deletion review")],
              ],
              "access",
            ) + area("message", tr("Talebin", "Your request")),
          onSubmit: async (data) => {
            await call("/data-requests", {
              body: {
                kind: data.get("kind"),
                message: data.get("message"),
                idempotencyKey: actionKey,
              },
            });
            toast(
              tr(
                "Talebin kaydedildi; finansal kayıtlar korunur.",
                "Request saved; financial records are retained.",
              ),
            );
          },
        });
      if (a === "review")
        return modal({
          title: tr("Değerlendirme yaz", "Write a review"),
          body:
            select(
              "productId",
              tr("Ürün", "Product"),
              JSON.parse(el.dataset.products).map((x) => [x.id, x.name]),
              "",
            ) +
            select(
              "rating",
              tr("Puan", "Rating"),
              [5, 4, 3, 2, 1].map((x) => [x, x + "/5"]),
              5,
            ) +
            field(
              "title",
              tr("Başlık", "Title"),
              "text",
              "",
              'required maxlength="100"',
            ) +
            area("message", tr("Yorumun", "Your review")),
          onSubmit: async (data) => {
            await call("/reviews", {
              body: {
                orderId: id,
                productId: data.get("productId"),
                rating: Number(data.get("rating")),
                title: data.get("title"),
                message: data.get("message"),
              },
            });
            metadata.delete(data.get("productId"));
            toast(
              tr(
                "Doğrulanmış değerlendirmen kaydedildi.",
                "Your verified review was saved.",
              ),
            );
          },
        });
      if (a === "reorder") {
        const orders = await api("/api/store/orders?limit=60"),
          order = orders.orders.find((x) => x.id === id);
        if (!order)
          throw new Error(
            tr("Sipariş listeni yenile.", "Refresh your orders."),
          );
        const available = order.items.filter((x) =>
          getProduct(x.productId)?.plans.some((p) => p.key === x.planKey),
        );
        if (available.length !== order.items.length)
          throw new Error(
            tr(
              "Bu siparişte artık satılmayan paketler var.",
              "This order includes packages no longer available.",
            ),
          );
        const accepted = await new Promise((resolve) => {
          resolve = confirmResult(resolve);
          const d = modal({
            title: tr(
              "Güncel fiyatla tekrar sipariş",
              "Order again at current prices",
            ),
            body: `<p>${tr("Ürünler güncel fiyatlarla sepetine eklenecek.", "Products will be added to your cart at current prices.")}</p>`,
            submit: tr("Sepete ekle", "Add to cart"),
            onSubmit: () => resolve(true),
          });
          d.element.addEventListener("close", () => resolve(false), {
            once: true,
          });
        });
        if (accepted) {
          await changeCart(() =>
            cart.replace(
              available.map((x) => ({
                productId: x.productId,
                planKey: x.planKey,
                quantity: x.quantity,
              })),
            ),
          );
          navigate("/sepet");
        }
        return;
      }
      if (a === "gift-delivery") {
        const r = await api(
          "/api/store/orders/" + encodeURIComponent(id) + "/delivery",
        );
        modal({
          title: tr("Hediye teslimatı", "Gift delivery"),
          body: (r.delivery.items || r.delivery.keys || [])
            .map(
              (x) =>
                `<div class="delivery-item"><b>${e(x.productName || x.label)}</b><code>${e(x.copyValue || x.value || x.key || "")}</code>${button("copy-secret", tr("Kopyala", "Copy"), "", `data-value="${e(x.copyValue || x.value || x.key || "")}"`)}</div>`,
            )
            .join(""),
        });
        return;
      }
      if (a === "copy-secret") {
        await copyText(el.dataset.value);
        toast(tr("Kopyalandı.", "Copied."));
        return;
      }
    } catch (error) {
      if (error.name !== "AbortError")
        toast(
          error.message || tr("İşlem tamamlanamadı.", "Operation failed."),
          "error",
        );
    } finally {
      busy(el, false);
      translate(document.body);
    }
  }
  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-commerce]");
    if (el) {
      event.preventDefault();
      void action(el);
    }
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id !== "commerce-preferences") return;
    event.preventDefault();
    const form = event.target,
      data = new FormData(form),
      submit = form.querySelector("[type=submit]");
    busy(submit, true);
    void save({
      preferences: {
        theme: data.get("theme"),
        language: data.get("language"),
        textScale: Number(data.get("textScale")),
        highContrast: data.has("highContrast"),
        reducedMotion: data.has("reducedMotion"),
        stockNotifications: data.has("stockNotifications"),
        priceNotifications: data.has("priceNotifications"),
        licenseReminders: data.has("licenseReminders"),
        emailStockNotifications: data.has("emailStockNotifications"),
        emailPriceNotifications: data.has("emailPriceNotifications"),
        emailLicenseReminders: data.has("emailLicenseReminders"),
        emailCouponNotifications: data.has("emailCouponNotifications"),
        emailOrderNotifications: data.has("emailOrderNotifications"),
        emailWalletNotifications: data.has("emailWalletNotifications"),
      },
    })
      .then(() => {
        toast(tr("Tercihlerin kaydedildi.", "Preferences saved."));
        refresh();
      })
      .catch((error) => toast(error.message, "error"))
      .finally(() => busy(submit, false));
  });
  return {
    connect,
    saveCart,
    saveFavorites,
    accountLinks,
    accountSection,
    productInfo,
    openOrder: orderDialog,
    ready,
    changeCart,
    productExtras,
    confirmCompatibility,
    checkoutQuote,
    acceptedPrice: (id, plan) =>
      profile?.cart.find((x) => x.productId === id && x.planKey === plan)
        ?.acceptedUnitPriceKurus,
    call,
    metadata,
    translate,
  };
}
