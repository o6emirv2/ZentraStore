const DATABASE = 'zentra-store-device-v1';
let identityPromise = null;
const registrations = new Map();
const failure = code => Object.assign(new Error(code), { code, mutationNotSent: true });
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2,'0')).join('');
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB || !globalThis.crypto?.subtle) { reject(failure('SECURITY_DEVICE_STORAGE_REQUIRED')); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('keys')) request.result.createObjectStore('keys'); };
    request.onerror = () => reject(failure('SECURITY_DEVICE_STORAGE_REQUIRED'));
    request.onblocked = () => reject(failure('SECURITY_DEVICE_STORAGE_REQUIRED'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function deviceIdentity() {
  if (identityPromise) return identityPromise;
  identityPromise = (async () => {
    const db = await openDatabase();
    try {
      const candidate = await crypto.subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, false, ['sign','verify']);
      const pair = await new Promise((resolve, reject) => {
        const tx = db.transaction('keys','readwrite'), store = tx.objectStore('keys'), read = store.get('identity');
        let selected;
        read.onsuccess = () => { selected = read.result || candidate; if (!read.result) store.put(candidate,'identity'); };
        tx.oncomplete = () => resolve(selected);
        tx.onerror = tx.onabort = () => reject(failure('SECURITY_DEVICE_STORAGE_REQUIRED'));
      });
      if (pair.privateKey?.extractable !== false || pair.privateKey?.algorithm?.namedCurve !== 'P-256') throw failure('SECURITY_DEVICE_STORAGE_REQUIRED');
      const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
      return { privateKey: pair.privateKey, publicKey: { kty, crv, x, y } };
    } finally { db.close(); }
  })().catch(error => { identityPromise = null; throw error.code ? error : failure('SECURITY_DEVICE_STORAGE_REQUIRED'); });
  return identityPromise;
}
export function needsDeviceProof(path, method = 'GET') {
  return (path.startsWith('/api/store/') && !['/api/store/catalog','/api/store/affiliate/resolve','/api/store/security/device'].includes(path))
    || path === '/api/profile/update' || path === '/api/auth/login' || (path === '/api/auth/session' && method === 'POST');
}
export async function storeDeviceHeaders({ url, method, body, headers, signal }) {
  const destination = new URL(url, location.href), identity = await deviceIdentity();
  let registration = registrations.get(destination.origin);
  if (!registration) {
    registration = (async () => {
      const bootstrapHeaders = new Headers({ 'Content-Type':'application/json', 'X-Zentra-Store-Client':'premium-store-v78' });
      const appCheck = headers.get('X-Firebase-AppCheck'); if (appCheck) bootstrapHeaders.set('X-Firebase-AppCheck', appCheck);
      const response = await fetch(destination.origin + '/api/store/security/device', { method:'POST', headers:bootstrapHeaders,
        credentials:'include', cache:'no-store', redirect:'error', signal, body:JSON.stringify({ publicKey: identity.publicKey }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !/^[a-f0-9]{64}$/.test(payload.deviceId || '')) throw failure(payload?.error || 'SECURITY_DEVICE_UNAVAILABLE');
      return payload.deviceId;
    })();
    registrations.set(destination.origin, registration);
    registration.catch(() => { if (registrations.get(destination.origin) === registration) registrations.delete(destination.origin); });
  }
  const deviceId = await registration;
  const parsedBody = body === undefined || body === null ? {} : typeof body === 'string' ? JSON.parse(body) : body;
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parsedBody))));
  const ts = Date.now(), nonce = encode(crypto.getRandomValues(new Uint8Array(18)));
  const message = JSON.stringify(['zentra-store-device-v1', deviceId, location.origin, method, destination.pathname + destination.search, bodyHash, ts, nonce]);
  const sig = encode(await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, identity.privateKey, new TextEncoder().encode(message)));
  return { 'X-Zentra-Device-Proof': encode(new TextEncoder().encode(JSON.stringify({ v:1, deviceId, ts, nonce, sig }))) };
}
