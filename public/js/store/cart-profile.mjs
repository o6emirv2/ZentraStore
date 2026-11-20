import { normalizeItems } from "../app/cart.mjs?v=109";

const itemKey = (row) => row.productId + ":" + row.planKey;
const storageKey = (uid) => "zentra-cart-v2" + (uid ? ":" + uid : "");

export function createProfileCart({ storage, request, display, report }) {
  let owner = "",
    version = 0,
    epoch = 0,
    last = [],
    queue = Promise.resolve();
  const read = (uid) => {
    try {
      return normalizeItems(
        JSON.parse(storage.getItem(storageKey(uid)) || "[]"),
      );
    } catch {
      return [];
    }
  };
  function persist(items) {
    last = normalizeItems(items);
    try {
      storage.setItem(storageKey(owner), JSON.stringify(last));
    } catch {}
  }
  const paint = () => display(last.map((row) => ({ ...row })));
  function enqueue(change, mergeGuest = false) {
    const uid = owner,
      generation = epoch,
      ticket = ++version;
    async function save() {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (uid !== owner || epoch !== generation) return;
        const { result } = await request("/api/store/commerce/profile");
        if (uid !== owner || epoch !== generation) return;
        const next = new Map(
          (result.cart || []).map((row) => [itemKey(row), row]),
        );
        for (const [key, row] of change) {
          if (!row) next.delete(key);
          else if (!mergeGuest || !next.has(key))
            next.set(key, { ...next.get(key), ...row });
        }
        const cart = [...next.values()].slice(0, 20);
        if (JSON.stringify(cart) !== JSON.stringify(result.cart || [])) {
          try {
            await request("/api/store/commerce/profile", {
              method: "PATCH",
              body: { expectedRevision: result.revision, cart },
            });
          } catch (error) {
            if (error.status === 409 && attempt < 2) continue;
            throw error;
          }
        }
        if (uid !== owner || epoch !== generation) return;
        if (mergeGuest) {
          try {
            storage.removeItem(storageKey(""));
          } catch {}
        }
        if (ticket === version) {
          persist(cart);
          paint();
        }
        return;
      }
    }
    queue = queue.then(save).catch((error) => {
      if (uid === owner && epoch === generation) report(error);
    });
    return queue;
  }
  return {
    restore() {
      last = read(owner);
      paint();
    },
    connect(uid = "") {
      if (uid === owner) return queue;
      const guest = owner ? [] : read("");
      owner = uid;
      version++;
      epoch++;
      last = read(owner);
      paint();
      return uid
        ? enqueue(
            guest.map((row) => [itemKey(row), row]),
            true,
          )
        : queue;
    },
    changed(items) {
      const before = new Map(last.map((row) => [itemKey(row), row]));
      persist(items);
      if (!owner) return queue;
      const next = new Map(last.map((row) => [itemKey(row), row]));
      const keys = new Set([...before.keys(), ...next.keys()]);
      const changes = [...keys]
        .filter((key) => before.get(key)?.quantity !== next.get(key)?.quantity)
        .map((key) => [key, next.get(key)]);
      return changes.length ? enqueue(changes) : queue;
    },
  };
}
