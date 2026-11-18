import { createAccountPages } from "/public/js/app/account-pages.mjs?v=108";
import { priceCart, checkoutState } from "/public/js/app/cart.mjs?v=108";
import { icon } from "/public/js/app/ui.js?v=108";
const catalog = await fetch("/api/store/catalog").then(res => res.json()).then(data => data.catalog),
  view = new URLSearchParams(location.search).get("view") || "account",
  empty = view.startsWith("empty-"), p = catalog.products[0],
  rows = empty ? [] : [{ productId: p.id, planKey: p.plans[0].key, quantity: 2 }, { productId: catalog.products[1].id, planKey: catalog.products[1].plans[1].key, quantity: 1 }],
  state = {
    auth: { account: { username: "Görünüm kontrolü", firstName: "Örnek", lastName: "Hesap", balanceKurus: 150000, birthDate: "1998-05-20" }, user: { email: "gorunum@zentra.invalid", emailVerified: true } },
    catalog, payment: "wallet", giftRecipient: "", orders: empty ? [] : [{ id: "VISUAL-SAMPLE-001", orderNumber: "ORNEK-001", status: "delivery_pending", paymentMethod: "wallet", paymentState: "paid", totalKurus: p.plans[0].priceKurus, createdAt: Date.now(), items: [{ productId: p.id, productName: p.name, planLabel: p.plans[0].label, quantity: 1, lineTotalKurus: p.plans[0].priceKurus }] }, { id: "VISUAL-SAMPLE-002", orderNumber: "ORNEK-002", status: "awaiting_payment", paymentMethod: "telegram", paymentState: "pending", totalKurus: p.plans[1].priceKurus, createdAt: Date.now(), items: [{ productId: p.id, productName: p.name, planLabel: p.plans[1].label, quantity: 1, lineTotalKurus: p.plans[1].priceKurus }] }], orderCursor: "",
  };
const pages = createAccountPages({
  state, uid: () => "preview", cart: { items: () => rows }, cartView: () => priceCart(rows, catalog),
  tracker: { pending: () => view === "pending-cart" ? { id: "preview" } : null }, checkoutState,
  commerce: { accountLinks: () => '<div class="commerce-shortcuts">' + [["support", "Destek taleplerim"], ["requests", "Taleplerim"], ["gifts", "Hediyelerim"], ["loyalty", "Zentra puanlarım"], ["sessions", "Oturumlarım"], ["preferences", "Görünüm ve bildirimler"], ["privacy", "Verilerim ve gizlilik"]].map(([id, label]) => `<a href="/hesabim?bolum=${id}">${icon(id === "sessions" ? "phone" : "shield")}<span>${label}</span>${icon("chevron")}</a>`).join("") + "</div>" },
  avatarMarkup: () => "Z", userName: () => "Zentra üyesi", currentRoute: () => ({ query: new URLSearchParams(view === "coupons" ? "tur=indirim" : "") }),
});
document.querySelector("main").innerHTML = `<p class="notice" role="status">Salt okunur görünüm kontrolü · Örnek hesap ve siparişler · Üretim verisi değildir.</p>` + (view.includes("cart") ? pages.cart() : view.includes("orders") ? pages.orders() : view === "coupons" ? pages.coupons([]) : pages.account());
document.querySelectorAll("button,input,select,textarea").forEach(control => control.disabled = true);
