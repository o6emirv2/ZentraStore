const invalid = message => { throw new Error(message); };

export function productPrice(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(raw))
    invalid("Paket fiyatını 300 veya 300,50 biçiminde yaz. En fazla iki ondalık hane kullanılabilir.");
  const [whole, fraction = ""] = raw.replace(",", ".").split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000000)
    invalid("Paket fiyatı ₺0,01 ile ₺1.000.000 arasında olmalı.");
  return amount;
}

export function productSortOrder(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 10000)
    invalid("Ürün sırası 0–10000 arasında tam sayı olmalı. Küçük değer önce gösterilir.");
  return Number(raw);
}

export function productPlans(rows, { creating = false, previous = [] } = {}) {
  if (!rows.length || rows.length > 12) invalid("En az bir, en fazla 12 paket tanımla.");
  const keys = new Set();
  return rows.map((row, index) => {
    const key = String(creating ? row.key : previous[index]?.key || "").trim();
    const label = String(row.label || "").trim(), duration = String(row.duration || "").trim();
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(key) || keys.has(key))
      invalid("Paket kodları benzersiz olmalı ve küçük harfle başlamalı.");
    if (!label || label.length > 50 || !duration || duration.length > 50)
      invalid("Her paketin adını ve süresini 1–50 karakterle belirt.");
    keys.add(key);
    return { key, label, duration, priceKurus: productPrice(row.price), active: previous[index]?.active !== false };
  });
}
