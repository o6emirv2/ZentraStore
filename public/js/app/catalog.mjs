import { CATEGORY_PRESETS } from "../store/catalog-schema.mjs?v=108";

export function filterProducts(
  catalog,
  r,
  { favorites = new Set(), categories = [] } = {},
) {
  let rows = [...(catalog?.products || [])];
  const q = r.query.get("q") || "",
    norm = (s) =>
      String(s)
        .toLocaleLowerCase("tr-TR")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ı/g, "i");
  if (q) {
    const nq = norm(q);
    rows = rows.filter((p) =>
      norm(
        [p.name, p.description, p.game, p.platform, ...(p.features || [])].join(
          " ",
        ),
      ).includes(nq),
    );
    if (!rows.length && nq.length >= 4)
      rows = (catalog?.products || []).filter((p) => {
        const n = norm(p.name);
        if (Math.abs(n.length - nq.length) > 1) return false;
        let misses = 0;
        for (let i = 0, j = 0; i < n.length || j < nq.length; ) {
          if (n[i] === nq[j]) {
            i++;
            j++;
            continue;
          }
          if (++misses > 1) return false;
          if (n.length > nq.length) i++;
          else if (n.length < nq.length) j++;
          else {
            i++;
            j++;
          }
        }
        return true;
      });
  }
  const cat = r.name === "category" ? r.id : r.query.get("category");
  if (cat) {
    const custom = categories.find((c) => c.id === cat);
    const preset = CATEGORY_PRESETS[cat];
    rows = rows.filter((p) =>
      preset ? p.game === preset.game && p.platform === preset.platform
        : custom ? custom.productIds.includes(p.id)
        : [p.platform, p.game, p.categoryKey].includes(cat),
    );
  }
  if (r.name === "favorites") rows = rows.filter((p) => favorites.has(p.id));
  if (r.query.get("featured")) rows = rows.filter((p) => p.featured);
  if (r.query.get("stock") === "1")
    rows = rows.filter((p) => p.stock?.available > 0);
  const min = Number(r.query.get("min")),
    max = Number(r.query.get("max"));
  if (min > 0)
    rows = rows.filter(
      (p) => Math.min(...p.plans.map((x) => x.priceKurus)) >= min * 100,
    );
  if (max > 0)
    rows = rows.filter(
      (p) => Math.min(...p.plans.map((x) => x.priceKurus)) <= max * 100,
    );
  const sort = r.query.get("sort");
  if (sort === "price-up" || sort === "price-down")
    rows.sort(
      (a, b) =>
        (Math.min(...a.plans.map((x) => x.priceKurus)) -
          Math.min(...b.plans.map((x) => x.priceKurus))) *
        (sort === "price-down" ? -1 : 1),
    );
  if (sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name, "tr"));
  return rows;
}
