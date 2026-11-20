import { isUncertainMutationError } from "../public/js/request-utils.js?v=109";
const failure = (code, message) => Object.assign(new Error(message), { code });
export function parseWalletAmount(value) {
  const raw = String(value || "").trim();
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(raw))
    throw failure(
      "STORE_BALANCE_ADJUSTMENT_INVALID",
      "Tutarı 5000 veya 5000,50 biçiminde, binlik ayırıcı kullanmadan yaz.",
    );
  const [whole, fraction = ""] = raw.replace(",", ".").split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000000)
    throw failure(
      "STORE_BALANCE_ADJUSTMENT_INVALID",
      "Tutar ₺0,01 ile ₺1.000.000 arasında olmalı.",
    );
  return amount;
}
export function createWalletOperation({
  api,
  reauthenticate,
  ensureActive,
  key = crypto.randomUUID(),
}) {
  let current = null,
    uncertain = false,
    committed = false,
    submitting = false;
  function snapshot() {
    return current
      ? structuredClone({ ...current, uncertain, committed })
      : null;
  }
  function result(body) {
    const r = body?.adjustment,
      p = current?.payload;
    if (
      !p ||
      r?.committed !== true ||
      r.uid !== p.uid ||
      r.type !== p.type ||
      r.amountKurus !== p.amountKurus ||
      !Number.isSafeInteger(r.balanceBeforeKurus) ||
      !Number.isSafeInteger(r.balanceAfterKurus) ||
      r.balanceBeforeKurus + r.amountKurus !== r.balanceAfterKurus ||
      r.balanceAfterKurus < 0 ||
      typeof r.transactionId !== "string" ||
      !/^[a-f0-9]{64}$/.test(r.transactionId)
    )
      throw failure(
        "STORE_WALLET_RESULT_UNVERIFIED",
        "İşlem sonucu doğrulanamadı. Yeniden bakiye eklemeden kayıt geçmişini kontrol et.",
      );
    uncertain = false;
    committed = true;
    return r;
  }
  async function prepare({ identifier, type, amount, reason }) {
    ensureActive();
    if (uncertain || committed)
      throw failure(
        "STORE_WALLET_RESULT_PENDING",
        "Önce mevcut işlemin sonucunu kontrol et.",
      );
    if (!["credit", "debit"].includes(type))
      throw failure("STORE_BALANCE_TYPE_INVALID", "İşlem türünü kontrol et.");
    const why = String(reason || "").trim(),
      query = String(identifier || "").trim();
    if (
      why.length < 6 ||
      why.length > 200 ||
      /[<>\u0000-\u001f\u007f]/.test(why)
    )
      throw failure(
        "STORE_BALANCE_REASON_REQUIRED",
        "6–200 karakterlik tek satırlı bir işlem gerekçesi yaz.",
      );
    if (!query || query.length > 254)
      throw failure(
        "STORE_USER_IDENTIFIER_REQUIRED",
        "Kullanıcı adı veya e-posta adresini yaz.",
      );
    const amountKurus = parseWalletAmount(amount) * (type === "debit" ? -1 : 1);
    const preview = await api(
      "/api/admin/store/wallet/recipient?identifier=" +
        encodeURIComponent(query),
    );
    ensureActive();
    const user = preview.recipient;
    if (
      preview.ok !== true ||
      !user?.uid ||
      !Number.isSafeInteger(user.balanceKurus) ||
      !preview.recipientToken
    )
      throw failure(
        "STORE_WALLET_PREVIEW_INVALID",
        "Hesap önizlemesi doğrulanamadı.",
      );
    if (user.balanceKurus + amountKurus < 0)
      throw failure(
        "STORE_BALANCE_WOULD_BE_NEGATIVE",
        "Bu işlem kullanılabilir bakiyeyi aşar.",
      );
    current = {
      intent: { identifier: query, type, amount, reason: why },
      recipient: user,
      expiresAt: preview.expiresAt,
      payload: {
        uid: user.uid,
        recipientToken: preview.recipientToken,
        type: type.toUpperCase(),
        amountKurus,
        reason: why,
        idempotencyKey: key,
      },
    };
    return snapshot();
  }
  async function recover() {
    ensureActive();
    const found = await api(
      "/api/admin/store/wallet/attempt?idempotencyKey=" +
        encodeURIComponent(key),
    );
    ensureActive();
    if (found.ok !== true || found.found !== true)
      throw failure(
        "STORE_WALLET_RESULT_PENDING",
        "İşlem sonucu henüz doğrulanamadı. Sonucu kontrol et düğmesini kullan; yeniden bakiye ekleme.",
      );
    return result(found);
  }
  async function submit(password) {
    ensureActive();
    if (submitting)
      throw failure(
        "STORE_WALLET_RESULT_PENDING",
        "İşlem sürüyor; sonucunu bekle.",
      );
    if (!current)
      throw failure(
        "STORE_WALLET_PREVIEW_INVALID",
        "Önce müşteri hesabını doğrula.",
      );
    if (uncertain || committed) return recover();
    submitting = true;
    let mutationStarted = false;
    try {
      await reauthenticate(password);
      ensureActive();
      mutationStarted = true;
      uncertain = true;
      const response = await api("/api/admin/store/wallet/adjust", {
        method: "POST",
        body: structuredClone(current.payload),
        timeoutMs: 30000,
      });
      ensureActive();
      return result(response);
    } catch (error) {
      ensureActive();
      if (!mutationStarted) throw error;
      if (
        error.code !== "STORE_WALLET_RESULT_UNVERIFIED" &&
        !isUncertainMutationError(error)
      ) {
        uncertain = false;
        throw error;
      }
      uncertain = true;
      try {
        return await recover();
      } catch {
        throw failure(
          "STORE_WALLET_RESULT_PENDING",
          "Gönderilen bakiye işleminin sonucu doğrulanamadı. Sonucu kontrol et düğmesini kullan; tekrar bakiye ekleme.",
        );
      }
    } finally {
      submitting = false;
    }
  }
  return { prepare, submit, recover, snapshot };
}
