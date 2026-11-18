import { isUncertainMutationError } from "../public/js/request-utils.js?v=109";
const BASE = "/api/admin/store/inventory";
const fail = (message) => new Error(message);
export function createInventoryImport({
  api,
  reauthenticate,
  ensureActive,
  newId = () => crypto.randomUUID(),
}) {
  let payload = null,
    pending = false,
    uncertain = false,
    completed = false;
  function result(response) {
    const r = response?.result;
    if (
      r?.committed !== true ||
      r.productId !== payload?.productId ||
      r.planKey !== payload?.planKey ||
      r.imported !== payload?.keys.length
    )
      throw Object.assign(
        fail(
          "Stok aktarımı kayıttan doğrulanamadı. Yeniden eklemeden sonucu kontrol et.",
        ),
        { code: "STORE_INVENTORY_RESULT_UNVERIFIED" },
      );
    uncertain = false;
    completed = true;
    return r;
  }
  async function recover() {
    ensureActive();
    if (!payload) throw fail("Önce stok bilgilerini kontrol et.");
    const r = await api(
      BASE +
        "/import-attempt?idempotencyKey=" +
        encodeURIComponent(payload.idempotencyKey),
    );
    ensureActive();
    if (!r.found)
      throw fail(
        "İşlem sonucu henüz kesinleşmedi. Yeni aktarım başlatmadan yeniden kontrol et.",
      );
    return result(r);
  }
  async function prepare(input, password) {
    if (pending || uncertain || completed)
      throw fail("Mevcut stok aktarımının sonucunu kontrol et.");
    pending = true;
    try {
      ensureActive();
      const candidate = structuredClone(input);
      if (!Array.isArray(candidate.keys) || !candidate.keys.length)
        throw fail("En az bir stok kaydı gir.");
      await reauthenticate(password);
      ensureActive();
      const preview = await api(BASE + "/import-check", { body: candidate });
      ensureActive();
      if (
        preview.result?.productId !== candidate.productId ||
        preview.result?.planKey !== candidate.planKey ||
        preview.result?.total !== candidate.keys.length
      )
        throw fail("Stok önizlemesi doğrulanamadı.");
      payload = { ...candidate, idempotencyKey: newId() };
      return structuredClone(preview.result);
    } finally {
      pending = false;
    }
  }
  async function submit(password) {
    if (pending) throw fail("Stok aktarımı devam ediyor.");
    if (!payload) throw fail("Önce stok bilgilerini kontrol et.");
    if (uncertain || completed) return recover();
    pending = true;
    let sent = false;
    try {
      await reauthenticate(password);
      ensureActive();
      sent = uncertain = true;
      const response = await api(BASE + "/import", {
        body: structuredClone(payload),
        timeoutMs: 30000,
      });
      ensureActive();
      return result(response);
    } catch (error) {
      ensureActive();
      if (!sent) throw error;
      if (
        !isUncertainMutationError(error) &&
        error.code !== "STORE_INVENTORY_RESULT_UNVERIFIED"
      ) {
        uncertain = false;
        throw error;
      }
      try {
        return await recover();
      } catch {
        throw fail(
          "Gönderilen stok aktarımının sonucu belirsiz. Sonucu kontrol et düğmesini kullan; aynı stokları tekrar ekleme.",
        );
      }
    } finally {
      pending = false;
    }
  }
  return {
    prepare,
    submit,
    recover,
    state: () => ({ uncertain, completed, pending }),
  };
}
