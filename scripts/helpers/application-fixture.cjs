'use strict';
const http = require('node:http'), crypto = require('node:crypto');
const { memoryFirestore, mockModule, admin } = require('./memory-firestore.cjs');

// Only the external Firebase/provider boundaries are adapted. Express routes and business services are real.
async function applicationFixture() {
  const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, password = 'Fixture Password 2026!';
  const four = 'Fixture factor four!', five = 'Fixture factor five!', secret = crypto.randomBytes(20), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', base32 = ''; for (const byte of secret) bits += byte.toString(2).padStart(8, '0');
  for (let index = 0; index < bits.length; index += 5) base32 += alphabet[parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  const totp = () => { const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const h = crypto.createHmac('sha1', secret).update(counter).digest(), offset = h.at(-1) & 15; return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0'); };
  const saltFour = crypto.randomBytes(32), saltFive = crypto.randomBytes(32), pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, {
    NODE_ENV: 'development', PUBLIC_BASE_URL: origin, PUBLIC_BACKEND_ORIGIN: origin, ALLOWED_ORIGINS: origin,
    APP_CHECK_MODE: 'enforce', PUBLIC_FIREBASE_APP_CHECK_SITE_KEY: 'integration-site-key', ADMIN_TOTP_MODE: 'required', RATE_LIMIT_STORE: 'firestore',
    PUBLIC_FIREBASE_CONFIG: JSON.stringify({ apiKey: crypto.randomBytes(25).toString('base64url'), authDomain: 'zentra-integration.firebaseapp.com', projectId: 'zentra-integration', appId: '1:100:web:integration' }),
    FIREBASE_KEY: JSON.stringify({ type: 'service_account', project_id: 'zentra-integration', client_email: 'svc@zentra-integration.iam.gserviceaccount.com', private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
    ADMIN_EMAILS: 'owner@zentra.invalid', ADMIN_UIDS: 'owneruid',
    ADMIN_GATE_FOUR_SALT_HEX: saltFour.toString('hex'), ADMIN_GATE_FOUR_HASH_HEX: crypto.scryptSync(four, saltFour, 32).toString('hex'),
    ADMIN_GATE_FIVE_SALT_HEX: saltFive.toString('hex'), ADMIN_GATE_FIVE_HASH_HEX: crypto.scryptSync(five, saltFive, 32).toString('hex'),
    ADMIN_GATE_SIGNING_SECRET: crypto.randomBytes(48).toString('base64url'),
    STORE_KEY_ACTIVE_KEY_ID: 'legacy-v1', STORE_KEY_ENCRYPTION_SECRET: crypto.randomBytes(48).toString('base64url'), STORE_KEY_FINGERPRINT_SECRET: crypto.randomBytes(48).toString('base64url'), ADMIN_TOTP_SECRET_BASE32: base32
  });
  const db = memoryFirestore([
    ['users/member', { username: 'EmirHan', usernameLower: 'emirhan', email: 'member@zentra.invalid', firstName: 'Emir', lastName: 'Deneme', birthDate: '2000-01-01', storeBalanceKurus: 50000, storeProfile: { avatarId: '1' }, storeAccountStatus: 'active', createdAt: Date.now() }],
    ['users/owneruid', { username: 'ShopOwner', email: 'owner@zentra.invalid', storeBalanceKurus: 0, storeProfile: { avatarId: '1' } }],
    ['users/finance', { username: 'FinanceUser', email: 'finance@zentra.invalid', storeBalanceKurus: 0, storeProfile: { avatarId: '1' } }],
    ['adminUsers/finance', { email: 'finance@zentra.invalid', role: 'finance', active: true }], ['adminUsers/viewer', { email: 'viewer@zentra.invalid', role: 'viewer', active: true }]
  ]);
  const users = new Map(['member', 'owneruid', 'finance', 'viewer'].map(uid => [uid, { uid, email: `${uid === 'owneruid' ? 'owner' : uid}@zentra.invalid`, emailVerified: true, disabled: false, password, generation: 0 }]));
  const idTokens = new Map(), customTokens = new Map(), cookies = new Map();
  const notFound = () => Object.assign(new Error('missing fixture identity'), { code: 'auth/user-not-found' });
  function publicUser(uid) { const row = users.get(uid); if (!row) throw notFound(); const { password: _password, generation: _generation, ...visible } = row; return { ...visible }; }
  function idToken(uid, authTime = Math.floor(Date.now() / 1000)) {
    if (uid === 'owner') uid = 'owneruid'; const row = users.get(uid); if (!row) throw notFound();
    const token = 'fixture-id-' + crypto.randomBytes(24).toString('base64url'); idTokens.set(token, { uid, email: row.email, email_verified: row.emailVerified, auth_time: authTime, generation: row.generation, firebase: { sign_in_provider: 'password' } }); return token;
  }
  function verified(token, map) { const row = map.get(token), user = row && users.get(row.uid); if (!user || user.disabled || row.generation !== user.generation) throw Object.assign(new Error('invalid fixture token'), { code: 'auth/id-token-revoked' }); return { ...row }; }
  const auth = {
    getUser: async uid => publicUser(uid),
    getUserByEmail: async email => { const row = [...users.values()].find(user => user.email === email); if (!row) throw notFound(); return publicUser(row.uid); },
    listUsers: async (limit = 1000) => ({ users: [...users].slice(0, limit).map(([uid]) => publicUser(uid)) }),
    getUsers: async ids => ({ users: ids.flatMap(value => users.has(value.uid) ? [publicUser(value.uid)] : []), notFound: ids.filter(value => !users.has(value.uid)) }),
    verifyIdToken: async (token, checkRevoked) => { if (checkRevoked !== true) throw new Error('revocation verification required'); return verified(token, idTokens); },
    verifySessionCookie: async (token, checkRevoked) => { if (checkRevoked !== true) throw new Error('revocation verification required'); return verified(token, cookies); },
    createSessionCookie: async token => { const claims = verified(token, idTokens), cookie = 'fixture-cookie-' + crypto.randomBytes(24).toString('base64url'); cookies.set(cookie, claims); return cookie; },
    createCustomToken: async uid => { publicUser(uid); const token = 'fixture-custom-' + crypto.randomBytes(24).toString('base64url'); customTokens.set(token, uid); return token; },
    revokeRefreshTokens: async uid => { if (!users.has(uid)) throw notFound(); users.get(uid).generation++; }
  };
  mockModule('../../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ enabled: true, db, auth, admin, appCheck: { verifyToken: async token => { if (token !== 'fixture-appcheck') throw new Error('invalid fixture appcheck'); return { app_id: 'fixture' }; } } }) });
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (!String(url).startsWith('https://identitytoolkit.googleapis.com/')) return originalFetch(url, options);
    const input = JSON.parse(options.body), user = [...users.values()].find(row => row.email === input.email), ok = !!user && !user.disabled && user.password === input.password;
    return { ok, status: ok ? 200 : 400, json: async () => ok ? { localId: user.uid, email: user.email } : { error: { message: 'INVALID_LOGIN_CREDENTIALS' } } };
  };
  const { app } = require('../../server.js'); server.on('request', app);
  const requests = [];
  async function request(path, { uid, token, cookie = '', method = 'GET', body, client = 'secure-admin-v77', headers = {} } = {}) {
    const bearer = token || (uid ? idToken(uid) : '');
    const response = await originalFetch(origin + path, { method, headers: { origin, 'x-zentra-store-client': client, 'x-firebase-appcheck': 'fixture-appcheck', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json(); requests.push({ path, method, status: response.status }); return { status: response.status, body: payload, headers: response.headers };
  }
  const cookieFrom = headers => headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.endsWith('=')).join('; ');
  async function openAdmin(uid = 'owneruid') {
    const token = idToken(uid); let ticket = '', cookie = '';
    for (const [step, extra] of [['email', {}], ['uid', {}], ['firebase-password', { password }], ['four', { password: four }], ['five', { password: five, totpCode: totp() }]]) {
      const result = await request(`/api/auth/admin/gate/step-${step}`, { token, cookie, method: 'POST', body: { ...(ticket ? { ticket } : {}), ...extra } });
      if (result.status !== 200) throw new Error(`gate ${step}: ${result.status} ${JSON.stringify(result.body)}`);
      ticket = result.body.ticket || ticket; cookie = [cookie, cookieFrom(result.headers)].filter(Boolean).join('; ');
    }
    return { uid, token, cookie };
  }
  async function adminWrite(session, path, method, body) {
    const proof = await request('/api/admin/action-proof', { ...session, method: 'POST', body: { method, path, bodyHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'), password } });
    if (proof.status !== 200) return proof;
    return request(path, { ...session, method, body, headers: { 'x-admin-action': proof.body.proof.token } });
  }
  return { app, origin, db, auth, users, password, idToken, request, requests, openAdmin, adminWrite,
    exchangeCustomToken: token => { const uid = customTokens.get(token); if (!uid) throw notFound(); return { ...publicUser(uid), idToken: idToken(uid) }; },
    close: async () => { await new Promise(resolve => server.close(resolve)); global.fetch = originalFetch; } };
}
module.exports = { applicationFixture };
