const KEY = "zentra-cart-v2";
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
export function normalizeItems(input) {
  if (!Array.isArray(input)) return [];
  const output = new Map();
  for (const row of input.slice(0, 100)) {
    if (
      !row ||
      !ID.test(row.productId) ||
      !ID.test(row.planKey) ||
      !Number.isSafeInteger(row.quantity) ||
      row.quantity < 1 ||
      row.quantity > 5
    )
      continue;
    const id = `${row.productId}:${row.planKey}`;
    if (!output.has(id) && output.size >= 20) continue;
    output.set(id, {
      productId: row.productId,
      planKey: row.planKey,
      quantity: Math.min(5, (output.get(id)?.quantity || 0) + row.quantity),
    });
  }
  return [...output.values()];
}
export function createCart(storage) {
  let items = [],
    ownerId = null;
  const storageKey = () => (ownerId ? KEY + ":" + ownerId : KEY);
  try {
    const saved = storage?.getItem(KEY);
    if (saved && saved.length <= 15000)
      items = normalizeItems(JSON.parse(saved));
  } catch {}
  function save() {
    try {
      storage?.setItem(storageKey(), JSON.stringify(items));
    } catch {}
  }
  return {
    items: () => items.map((x) => ({ ...x })),
    owner(uid) {
      ownerId = String(uid || "");
      items = [];
      if (!ownerId) {
        try {
          storage?.removeItem(KEY);
        } catch {}
        return;
      }
      try {
        const raw = storage?.getItem(storageKey());
        if (raw && raw.length < 15000) items = normalizeItems(JSON.parse(raw));
      } catch {}
    },
    replace(value) {
      items = normalizeItems(value);
      save();
    },
    add(productId, planKey) {
      const found = items.find(
        (x) => x.productId === productId && x.planKey === planKey,
      );
      if (found?.quantity >= 5)
        throw new Error("Bir paketten en fazla 5 adet seçebilirsiniz.");
      if (!found && items.length >= 20)
        throw new Error("Sepete en fazla 20 farklı paket ekleyebilirsiniz.");
      items = normalizeItems([...items, { productId, planKey, quantity: 1 }]);
      save();
    },
    quantity(productId, planKey, quantity) {
      items = normalizeItems(
        items.map((x) =>
          x.productId === productId && x.planKey === planKey
            ? { ...x, quantity }
            : x,
        ),
      );
      save();
    },
    remove(productId, planKey) {
      items = items.filter(
        (x) => x.productId !== productId || x.planKey !== planKey,
      );
      save();
    },
    clear() {
      items = [];
      save();
    },
  };
}
export function priceCart(items, catalog) {
  const lines = [],
    invalid = [];
  for (const row of normalizeItems(items)) {
    const product = catalog?.products?.find((x) => x.id === row.productId),
      plan = product?.plans?.find((x) => x.key === row.planKey);
    if (
      !product ||
      !plan ||
      product.active === false ||
      product.archived === true
    ) {
      invalid.push(row);
      continue;
    }
    lines.push({
      ...row,
      product,
      plan,
      totalKurus: plan.priceKurus * row.quantity,
    });
  }
  return {
    lines,
    invalid,
    totalKurus: lines.reduce((s, x) => s + x.totalKurus, 0),
  };
}

export function checkoutState({
  signedIn = false,
  busy = false,
  invalidItems = false,
  payment = "wallet",
  telegramEnabled = true,
} = {}) {
  if (busy)
    return {
      disabled: true,
      label: "Sipariş doğrulanıyor…",
      message: "İşlem sonucu bekleniyor. Aynı siparişi yeniden göndermeyin.",
    };
  if (!signedIn)
    return { disabled: false, label: "Giriş yap ve devam et", message: "" };
  if (invalidItems)
    return {
      disabled: true,
      label: "Sepetini kontrol et",
      message:
        "Artık satışta olmayan ürünleri kaldırdıktan sonra devam edebilirsin.",
    };
  if (payment === "telegram" && telegramEnabled === false)
    return {
      disabled: true,
      label: "Telegram siparişleri kapalı",
      message:
        "Telegram sipariş kanalı şu an kapalı. Başka bir ödeme yöntemi seçebilir veya destek ekibine ulaşabilirsin.",
    };
  return { disabled: false, label: "Siparişi oluştur", message: "" };
}
