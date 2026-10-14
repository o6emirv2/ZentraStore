'use strict';
window.ZENTRA_ADMIN_BROWSER = (() => {
  const REFERENCE = 'zentra_admin_browser_ref_v1';
  let current = null, persistent = true;
  const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const error = () => Object.assign(new Error('Güvenli yönetici oturumu bu tarayıcıda hazırlanamadı. HTTPS bağlantısını kontrol edin.'), { code: 'ADMIN_BROWSER_UNAVAILABLE' });
  async function storage(mode, key, value) {
    if (!window.indexedDB) throw error();
    const database = await new Promise((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => { finished = true; reject(error()); }, 3000);
      const request = indexedDB.open('zentra-admin-browser-v1', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('keys', { keyPath: 'keyId' }); };
      request.onerror = () => { clearTimeout(timer); reject(error()); };
      request.onblocked = () => { clearTimeout(timer); reject(error()); };
      request.onsuccess = () => { clearTimeout(timer); if (finished) request.result.close(); else resolve(request.result); };
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('keys', mode === 'get' ? 'readonly' : 'readwrite');
        const store = transaction.objectStore('keys');
        const request = mode === 'get' ? store.get(key) : mode === 'delete' ? store.delete(key) : store.put(value);
        let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(error());
      });
    } finally { database.close(); }
  }
  async function persist() {
    if (!current) return;
    try { await storage('put', current.keyId, current); sessionStorage.setItem(REFERENCE, JSON.stringify({ keyId: current.keyId, uid: current.uid })); }
    catch (_) { persistent = false; }
  }
  async function clear() {
    const previous = current; current = null;
    try { sessionStorage.removeItem(REFERENCE); } catch (_) {}
    if (previous) await storage('delete', previous.keyId).catch(() => {});
  }
  async function restore(uid) {
    if (current?.uid === uid) return;
    current = null;
    try {
      const reference = JSON.parse(sessionStorage.getItem(REFERENCE) || 'null');
      if (!reference || reference.uid !== uid || !/^[a-f0-9-]{36}$/.test(reference.keyId)) return;
      const saved = await storage('get', reference.keyId);
      if (saved?.uid === uid && saved.expiresAt > Date.now() && saved.privateKey?.type === 'private' && saved.privateKey.extractable === false) current = saved;
      else { sessionStorage.removeItem(REFERENCE); await storage('delete', reference.keyId); }
    } catch (_) { persistent = false; }
  }
  async function prepare(uid) {
    if (!uid || !crypto?.subtle || !crypto.randomUUID) throw error();
    if (current?.uid === uid && !current.session) return { keyId: current.keyId, publicKey: current.publicKey };
    await clear();
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
    current = { uid, keyId: crypto.randomUUID(), privateKey: pair.privateKey,
      publicKey: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y }, session: '', expiresAt: Date.now() + 7 * 60_000 };
    await persist();
    return { keyId: current.keyId, publicKey: current.publicKey };
  }
  async function accept(result) {
    if (!current || result?.keyId !== current.keyId || !/^[A-Za-z0-9_-]{32,80}$/.test(String(result?.session || ''))
      || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 12 * 60 * 60_000 + 60_000) throw error();
    current = { ...current, session: result.session, expiresAt: result.expiresAt }; await persist();
  }
  async function proof(url, method, body, uid) {
    const saved = current;
    if (!saved || saved.uid !== uid || saved.expiresAt <= Date.now()) return '';
    const target = new URL(url, location.href);
    const gateStep = /^\/api\/auth\/admin\/gate\/step-/.test(target.pathname);
    if (!saved.session && !gateStep) return '';
    const session = gateStep ? '' : saved.session, ts = Date.now(), nonce = encode(crypto.getRandomValues(new Uint8Array(18)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body || '{}'));
    const hash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
    const message = JSON.stringify(['zentra-browser-admin-v1', uid, saved.keyId, session, location.origin, method, target.pathname + target.search, hash, ts, nonce]);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, saved.privateKey, new TextEncoder().encode(message));
    if (current !== saved) throw Object.assign(new Error('Yönetici oturumu değişti.'), { code: 'ADMIN_ACTIVE_SESSION_MISMATCH' });
    return encode(new TextEncoder().encode(JSON.stringify({ v: 1, keyId: saved.keyId, session, ts, nonce, sig: encode(signature) })));
  }
  return { restore, prepare, accept, proof, clear, persistent: () => persistent };
})();
