export function createAccountReader({ userId, read, start, accept, failed, finish }) {
  let revision = 0, pending = null;
  const invalidate = () => { revision++; pending?.controller.abort(); pending = null; };
  function valid(account, uid) {
    if (!account || String(account.uid || '') !== uid) throw Object.assign(new Error('Hesap cevabı bu oturumla eşleşmedi.'), { code: 'AUTH_ACCOUNT_MISMATCH' });
    if (!Number.isSafeInteger(account.balanceKurus) || account.balanceKurus < 0) throw Object.assign(new Error('Hesap bakiyesi doğrulanamadı.'), { code: 'RESPONSE_INVALID' });
  }
  function confirm(account) { valid(account, userId()); invalidate(); accept(account); finish(); return account; }
  function load({ force = false } = {}) {
    const uid = userId(); if (!uid) return Promise.resolve(null);
    if (pending?.uid === uid && !force) return pending.promise;
    invalidate(); const current = revision, controller = new AbortController(), active = () => current === revision && uid === userId(); start();
    const promise = Promise.resolve().then(() => read(controller.signal)).then(payload => {
      if (!active()) return null; valid(payload.account, uid); accept(payload.account); return payload.account;
    }).catch(error => { if (!active() || error.name === 'AbortError') return null; failed(error); throw error; })
      .finally(() => { if (active()) { pending = null; finish(); } });
    pending = { uid, promise, controller }; return promise;
  }
  return { invalidate, load, confirm };
}
