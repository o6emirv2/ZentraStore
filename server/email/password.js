"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { identityRequest } = require("../core/firebaseIdentityClient");
const { purposeKey } = require("../core/adminAccessService");
const { failure } = require("./config");
const { enqueue } = require("./service");
async function changePassword(uid, input = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 3 ||
    Object.keys(input).some(
      (k) => !["currentPassword", "newPassword", "idempotencyKey"].includes(k),
    ) ||
    typeof input.currentPassword !== "string" ||
    !input.currentPassword ||
    input.currentPassword.length > 4096 ||
    typeof input.newPassword !== "string" ||
    input.newPassword.length < 8 ||
    input.newPassword.length > 4096 ||
    input.newPassword === input.currentPassword ||
    typeof input.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_-]{12,100}$/.test(input.idempotencyKey)
  )
    throw failure("PASSWORD_INPUT_INVALID");
  const { db, auth } = initFirebaseAdmin();
  if (!db || !auth) throw failure("AUTH_UNAVAILABLE", 503);
  const operationId = crypto
    .createHash("sha256")
    .update(uid + "\0" + input.idempotencyKey)
    .digest("hex");
  const ref = db.collection("storePasswordOperations").doc(operationId);
  const lockRef = db
    .collection("storePasswordLocks")
    .doc(crypto.createHash("sha256").update(uid).digest("hex"));
  const inputDigest = crypto
    .createHmac("sha256", purposeKey("password-operation-v1"))
    .update(operationId + "\0" + input.newPassword)
    .digest("hex");
  function replay(row) {
    if (row.uid !== uid || row.inputDigest !== inputDigest)
      throw failure("PASSWORD_OPERATION_CONFLICT", 409);
    if (row.state !== "completed")
      throw failure("PASSWORD_CHANGE_UNCERTAIN", 409);
    return { changed: true, idempotentReplay: true };
  }
  const old = await ref.get();
  if (old.exists) return replay(old.data());
  const account = await auth.getUser(uid);
  if (account.disabled || !account.email) throw failure("AUTH_INVALID", 401);
  const credential = await identityRequest("signInWithPassword", {
    email: account.email,
    password: input.currentPassword,
    returnSecureToken: true,
  });
  if (
    !credential.ok ||
    credential.payload.localId !== uid ||
    !credential.payload.idToken
  )
    throw failure("AUTH_INVALID", 401);
  const prepared = await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (current.exists) return replay(current.data());
    const lock = (await tx.get(lockRef)).data();
    if (lock?.expiresAt > Date.now())
      throw failure("PASSWORD_CHANGE_IN_PROGRESS", 409);
    tx.create(ref, {
      uid,
      inputDigest,
      state: "started",
      createdAt: Date.now(),
    });
    tx.set(lockRef, { operationId, expiresAt: Date.now() + 120000 });
    return null;
  });
  if (prepared) return prepared;
  let response;
  try {
    response = await identityRequest("update", {
      idToken: credential.payload.idToken,
      password: input.newPassword,
      returnSecureToken: true,
    });
  } catch {
    await ref
      .update({ state: "uncertain", updatedAt: Date.now() })
      .catch(() => {});
    throw failure("PASSWORD_CHANGE_UNCERTAIN", 503);
  }
  if (!response.ok) {
    const uncertain = response.status >= 500;
    await ref.update({
      state: uncertain ? "uncertain" : "rejected",
      updatedAt: Date.now(),
    });
    throw failure(
      uncertain ? "PASSWORD_CHANGE_UNCERTAIN" : "PASSWORD_CHANGE_REJECTED",
      uncertain ? 503 : 400,
    );
  }
  if (response.payload.localId !== uid) {
    await ref.update({ state: "uncertain", updatedAt: Date.now() });
    throw failure("PASSWORD_CHANGE_UNCERTAIN", 503);
  }
  try {
    await db.runTransaction(async (tx) => {
      const row = (await tx.get(ref)).data();
      if (row?.state === "completed") return;
      const lock = (await tx.get(lockRef)).data();
      const now = Date.now();
      tx.update(ref, { state: "completed", completedAt: now, updatedAt: now });
      if (lock?.operationId === operationId)
        tx.set(lockRef, { operationId: "", expiresAt: 0 });
      require("../core/customerNotificationService").recordEvent(tx, db, {
        uid,
        key: operationId,
        type: "security",
        title: "Şifren güncellendi",
        message:
          "Hesabının şifre değişikliği sağlayıcı tarafından doğrulandı. Bu işlemi sen yapmadıysan hesabını güvene al.",
        now,
      });
      enqueue(tx, db, {
        uid,
        type: "password_changed",
        key: operationId,
        data: { operationId },
        now,
      });
      require("../core/storeMutationAudit").recordMutationAudit(
        tx,
        db,
        "store.password.change",
        { uid },
        { operationId, providerConfirmed: true },
      );
    });
  } catch {
    throw failure("PASSWORD_CHANGE_UNCERTAIN", 503);
  }
  return { changed: true, idempotentReplay: false };
}
module.exports = { changePassword };
