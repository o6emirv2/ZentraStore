"use strict";
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { failure } = require("./config");
const { recordMutationAudit } = require("../core/storeMutationAudit");

const labels = Object.freeze({
  recovery_password: "Şifre sıfırlama bağlantısı",
  recovery_username: "Kullanıcı adı hatırlatma",
  verification: "E-posta doğrulama",
  password_changed: "Şifre değişikliği",
  password_reset_completed: "Şifre sıfırlama tamamlandı",
  username_changed: "Kullanıcı adı değişikliği",
  new_device: "Yeni cihazdan giriş",
  stock: "Stok eklendi",
  restock: "Stok gelince bildir",
  price: "Favori veya takip edilen üründe indirim",
  wallet_credit: "Bakiye eklendi",
  coupon_assigned: "Kupon eklendi",
  promo_added: "Promosyon eklendi",
  license: "Lisans süresi",
  order_created: "Sipariş oluşturuldu",
  paid_delivered: "Ödeme ve teslimat",
  gift_received: "Hediye alındı",
  test: "Test iletisi",
});
const limits = { subject: 120, intro: 1000, label: 60 };
const variables = ["tarih", "urun", "kullanici", "kod", "tutar", "cihaz"];
function normalize(entry) {
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    Object.keys(entry).some((key) => !Object.hasOwn(limits, key))
  )
    throw failure("TEMPLATE_INVALID");
  const result = {};
  for (const [name, max] of Object.entries(limits)) {
    let value = entry[name] ?? "";
    if (typeof value === "string" && name === "intro")
      value = value.replace(/\r\n?/g, "\n");
    if (
      typeof value !== "string" ||
      value.length > max ||
      /[<>\u0000-\u0009\u000b-\u001f\u007f]/.test(value) ||
      (name !== "intro" && value.includes("\n")) ||
      value
        .replace(/\{(tarih|urun|kullanici|kod|tutar|cihaz)\}/g, "")
        .match(/[{}]/)
    )
      throw failure("TEMPLATE_INVALID");
    result[name] = value.trim();
  }
  return result;
}
const reference = (db) =>
  db.collection("storeNotificationTemplates").doc("main");
async function read(db = initFirebaseAdmin().db) {
  if (!db) throw failure("STORE_STORAGE_UNAVAILABLE", 503);
  const row = (await reference(db).get()).data() || {};
  return { templates: row.templates || {}, revision: row.revision || 0 };
}
async function save(type, input, actor) {
  if (!Object.hasOwn(labels, type) || !Number.isSafeInteger(input.revision))
    throw failure("TEMPLATE_INVALID");
  const template = normalize(input.template),
    { db } = initFirebaseAdmin();
  if (!db) throw failure("STORE_STORAGE_UNAVAILABLE", 503);
  return db.runTransaction(async (tx) => {
    const ref = reference(db),
      old = (await tx.get(ref)).data() || {};
    if (input.revision !== (old.revision || 0))
      throw failure("TEMPLATE_CHANGED", 409);
    const result = {
      templates: { ...old.templates, [type]: template },
      revision: input.revision + 1,
    };
    tx.set(ref, result);
    recordMutationAudit(tx, db, "store.notification-template.update", actor, {
      type,
      revision: result.revision,
    });
    return result;
  });
}
function apply(template = {}, defaults, data = {}) {
  const result = { ...defaults };
  for (const name of Object.keys(limits)) {
    if (!template[name]) continue;
    const keys = [...template[name].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (keys.some((key) => data[key] === undefined || data[key] === ""))
      continue;
    result[name] = template[name]
      .replace(/\{(\w+)\}/g, (_, key) => String(data[key]))
      .slice(0, limits[name] + 120);
  }
  return result;
}
module.exports = { labels, variables, normalize, read, save, apply };
