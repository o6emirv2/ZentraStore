import { escape as e, icon, date, modal, field, toast } from "./ui.js?v=108";
import { profileAvatar, profileLabel, likerRow } from "./community-profile.mjs?v=108";
const BASE = "/api/store/commerce/community";
const KEY = "zentra-community-visitor-v1";
export function createCommunity({ api, userId }) {
  let visitor = "",
    issuing = null;
  const states = new Map(),
    pending = new Map(),
    working = new Set();
  try {
    visitor = localStorage.getItem(KEY) || "";
  } catch {}
  const identity = () => userId() || "guest";
  const stateKey = (id) => identity() + ":" + id;
  async function ensureVisitor() {
    if (visitor) return visitor;
    if (!issuing)
      issuing = (async () => {
        const response = await api(BASE + "/visitor", {
          auth: false,
          body: {},
        });
        if (typeof response.result?.visitorToken !== "string")
          throw new Error("Ziyaretçi oturumu doğrulanamadı.");
        visitor = response.result.visitorToken;
        try {
          localStorage.setItem(KEY, visitor);
        } catch {}
        return visitor;
      })().finally(() => {
        issuing = null;
      });
    return issuing;
  }
  function options() {
    return {
      auth: !!userId(),
      headers: visitor && !userId() ? { "X-Zentra-Visitor": visitor } : {},
    };
  }
  async function load(id, { cursor = "" } = {}) {
    const key = stateKey(id),
      owner = identity();
    let response;
    try {
      response = await api(
        BASE +
          "/" +
          encodeURIComponent(id) +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        options(),
      );
    } catch (error) {
      if (!userId() && visitor && error.code === "COMMUNITY_VISITOR_REQUIRED") {
        visitor = "";
        try {
          localStorage.removeItem(KEY);
        } catch {}
      }
      throw error;
    }
    if (owner !== identity())
      throw new Error("Hesap değişti. Ürün etkileşimlerini yeniden aç.");
    const data = response.result;
    if (
      !data ||
      data.productId !== id ||
      !Number.isSafeInteger(data.likes) ||
      data.likes < 0 ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 0 ||
      typeof data.liked !== "boolean" ||
      !Array.isArray(data.reviews)
    )
      throw new Error("Ürün etkileşimleri doğrulanamadı.");
    const previous = states.get(key);
    if (cursor && previous)
      data.reviews = [
        ...new Map(
          [...previous.reviews, ...data.reviews].map((x) => [x.id, x]),
        ).values(),
      ];
    states.set(key, data);
    return data;
  }
  function markup(id) {
    const data = states.get(stateKey(id));
    if (!data)
      return `<section class="community panel" id="product-community" data-product="${e(id)}"><h2>Beğeniler ve yorumlar</h2><p>Ürün etkileşimleri henüz yüklenemedi.</p><button class="button secondary" data-community="refresh" data-id="${e(id)}">Yeniden dene</button></section>`;
    const eligible = data.eligibility?.eligible === true;
    return `<section class="community panel" id="product-community" data-product="${e(id)}" aria-labelledby="community-title"><div class="community-heading"><div><span class="eyebrow">ZENTRA TOPLULUĞU</span><h2 id="community-title">Deneyimler burada.</h2></div><button class="icon-button" data-community="refresh" data-id="${e(id)}" aria-label="Beğenileri ve yorumları yenile">${icon("refresh")}</button></div><div class="community-actions"><button type="button" class="community-like ${data.liked ? "is-liked" : ""}" data-community="like" data-id="${e(id)}" aria-pressed="${data.liked}" aria-label="${data.liked ? "Beğeniyi geri al" : "Ürünü beğen"}">${icon("heart")}<strong>${data.likes}</strong><span>beğeni</span></button><button type="button" class="community-comments-link" data-community="people" data-id="${e(id)}">${icon("user")} Beğenenleri gör</button><a class="community-comments-link" href="#product-comments">${icon("comment")} Yorumlar</a><span class="community-availability">Beğenmek herkese açık</span></div><div class="community-compose">${profileAvatar(data.viewerProfile)}<div><b>Senin deneyimin nasıl?</b><p>${eligible ? "Bu ürünü satın aldın. Deneyimini paylaşabilirsin." : data.eligibility?.reason === "choose-order" ? "Satın aldığın siparişi Siparişlerim bölümünden seçerek yorum yap." : data.eligibility?.reason === "already-reviewed" ? "Bu ürün için değerlendirmen kayıtlı. Yayımlanma durumu yönetim politikasına bağlıdır." : "Yorumları yalnızca bu ürünü satın alan müşteriler paylaşabilir."}</p></div>${eligible ? `<button class="button primary small" data-community="review" data-id="${e(id)}">Yorum yap</button>` : !userId() ? '<a class="button secondary small" href="/hesabim?islem=giris" data-nav>Giriş yap</a>' : '<a class="button secondary small" href="/siparisler" data-nav>Siparişlerim</a>'}</div><div id="product-comments" class="community-comments">${data.reviews.length ? data.reviews.map((r) => `<article class="community-comment">${profileAvatar(r.profile)}<div><header><b>${e(profileLabel(r.profile))}</b><span class="verified-badge">${icon("check")} Doğrulanmış satın alma</span></header><div class="review-stars" aria-label="5 üzerinden ${e(r.rating)}">${"★".repeat(Math.min(5, Math.max(1, Number(r.rating) || 1)))}</div><h3>${e(r.title)}</h3><p data-user-content>${e(r.message)}</p><time>${date(r.createdAt)}</time></div></article>`).join("") : '<p class="community-empty">Henüz yorum yok. İlk gerçek deneyimi paylaşan sen olabilirsin.</p>'}</div>${data.nextCursor ? `<button class="button secondary" data-community="more" data-id="${e(id)}">Daha fazla yorum göster</button>` : ""}</section>`;
  }
  function paint(id) {
    const node = document.querySelector(
      '#product-community[data-product="' + CSS.escape(id) + '"]',
    );
    if (node) node.outerHTML = markup(id);
  }
  async function react(id) {
    const key = stateKey(id),
      owner = identity();
    if (working.has(key)) return;
    working.add(key);
    try {
      if (!userId()) await ensureVisitor();
      let current = states.get(key);
      if (!current) current = await load(id);
      const operation = pending.get(key) || {
        liked: !current.liked,
        expectedRevision: current.revision,
        mutationId: crypto.randomUUID(),
      };
      pending.set(key, operation);
      const response = await api(
        BASE + "/" + encodeURIComponent(id) + "/like",
        { ...options(), method: "PUT", body: operation },
      );
      if (owner !== identity()) throw new Error("Hesap oturumu değişti.");
      const result = response.result;
      if (
        result?.productId !== id ||
        typeof result.liked !== "boolean" ||
        (result.replayed !== true && result.liked !== operation.liked) ||
        !Number.isSafeInteger(result.likes) ||
        result.likes < 0 ||
        !Number.isSafeInteger(result.revision) ||
        result.revision < 0
      )
        throw new Error("Beğeni sonucu doğrulanamadı. Durumu kontrol et.");
      states.set(key, { ...current, ...result });
      pending.delete(key);
      paint(id);
    } catch (error) {
      if (owner === identity()) {
        if (
          [
            "COMMUNITY_REVISION_CONFLICT",
            "COMMUNITY_OPERATION_CONFLICT",
          ].includes(error.code)
        )
          pending.delete(key);
        await load(id)
          .then(() => paint(id))
          .catch(() => {});
      }
      throw error;
    } finally {
      working.delete(key);
    }
  }
  async function showLikers(id) {
    const owner = identity(), people = new Map();
    let cursor = "", loading = false;
    const dialog = modal({ title: "Beğenenler", symbol: "heart", body: '<div class="community-people" aria-live="polite"><p>Beğenenler yükleniyor…</p></div>' });
    const container = dialog.element.querySelector(".community-people");
    async function page() {
      if (loading) return;
      loading = true;
      container.setAttribute("aria-busy", "true");
      container.querySelectorAll("button").forEach(button => button.disabled = true);
      try {
        const response = await api(BASE + "/" + encodeURIComponent(id) + "/likes" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), { auth: false });
        if (owner !== identity() || !dialog.element.isConnected) return;
        const data = response.result;
        if (data?.productId !== id || !Array.isArray(data.people) || data.people.some(person => !person.id || !person.profile) || typeof data.nextCursor !== "string")
          throw new Error("Beğenenlerin profilleri doğrulanamadı.");
        data.people.forEach(person => people.set(person.id, person));
        cursor = data.nextCursor;
        container.innerHTML = (people.size ? '<ul class="community-people-list">' + [...people.values()].map(likerRow).join("") + '</ul>' : '<p>Henüz beğeni yok. İlk beğenen sen olabilirsin.</p>') + (cursor ? '<button type="button" class="button secondary" data-likers-next>Daha fazla göster</button>' : "");
      } catch (error) {
        if (owner !== identity() || !dialog.element.isConnected) return;
        if (error.code === "COMMUNITY_CURSOR_INVALID") { cursor = ""; people.clear(); }
        container.innerHTML = (people.size ? '<ul class="community-people-list">' + [...people.values()].map(likerRow).join("") + '</ul>' : "") + '<div class="notice error" role="alert">' + icon("warning") + '<p>' + e(error.message || "Profiller yüklenemedi.") + '</p></div><button type="button" class="button secondary" data-likers-next>Yeniden dene</button>';
      } finally {
        loading = false;
        container.removeAttribute("aria-busy");
        container.querySelectorAll("button").forEach(button => button.disabled = false);
      }
    }
    container.addEventListener("click", event => { if (event.target.closest("[data-likers-next]")) void page(); });
    await page();
  }
  function review(id) {
    const owner = identity(),
      data = states.get(stateKey(id));
    if (!userId() || !data?.eligibility?.eligible)
      throw new Error(
        "Yorum yazmak için bu ürüne ait tamamlanmış satın alma gerekli.",
      );
    modal({
      title: "Deneyimini paylaş",
      submit: "Yorumu yayımla",
      body: `${field("title", "Kısa başlık", "text", "", 'required maxlength="100"')}<label class="field"><span>Puanın</span><select name="rating" required>${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n} / 5</option>`).join("")}</select></label><label class="field"><span>Yorumun</span><textarea name="message" required minlength="3" maxlength="2000" rows="5" placeholder="Ürün hakkındaki deneyimini paylaş."></textarea></label><p class="fine-print">Kişisel bilgi, parola veya lisans kodu paylaşma.</p>`,
      onSubmit: async (form) => {
        if (owner !== identity()) throw new Error("Hesap oturumu değişti.");
        const response = await api("/api/store/commerce/reviews", {
          body: {
            orderId: data.eligibility.orderId,
            productId: id,
            title: form.get("title"),
            rating: Number(form.get("rating")),
            message: form.get("message"),
          },
        });
        if (owner !== identity() || response.result?.verifiedPurchase !== true)
          throw new Error("Yorumun kaydedildiği doğrulanamadı. Durumu yenile.");
        toast("Yorumun kaydedildi.");
        await load(id)
          .then(() => paint(id))
          .catch(() => {
            states.delete(stateKey(id));
            paint(id);
          });
      },
    });
  }
  async function click(event) {
    const button = event.target.closest("[data-community]");
    if (!button || button.disabled) return;
    event.preventDefault();
    const id = button.dataset.id,
      action = button.dataset.community;
    if (action === "review") {
      try {
        review(id);
      } catch (error) {
        toast(error.message, "error");
      }
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      if (action === "people") await showLikers(id);
      else if (action === "like") await react(id);
      else {
        const data = states.get(stateKey(id));
        await load(id, {
          cursor: action === "more" ? data?.nextCursor || "" : "",
        });
        paint(id);
      }
    } catch (error) {
      toast(error.message || "İşlem doğrulanamadı. Durumu yenile.", "error");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
  const doubleTap = (event) => {
    const media = event.target.closest?.(".product-detail-media");
    const id = media?.dataset.product;
    if (!id || states.get(stateKey(id))?.liked || !states.has(stateKey(id)))
      return;
    event.preventDefault();
    void react(id).catch((error) => toast(error.message, "error"));
  };
  const avatarError = event => {
    if (event.target.matches?.("img[data-community-avatar]")) event.target.hidden = true;
  };
  document.addEventListener("error", avatarError, true);
  document.addEventListener("dblclick", doubleTap);
  document.addEventListener("click", click);
  return {
    load,
    markup,
    react,
    dispose() {
      document.removeEventListener("click", click);
      document.removeEventListener("error", avatarError, true);
      document.removeEventListener("dblclick", doubleTap);
      states.clear();
      pending.clear();
    },
  };
}
