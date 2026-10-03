'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_ALGORITHM = 'sha1';
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

function totpError(code, statusCode = 401) {
  return Object.assign(new Error(code), { code, statusCode });
}

function decodeBase32(value = '') {
  const raw = String(value || '').replace(/[\s=-]/g, '').toUpperCase();
  if (!/^[A-Z2-7]{26,128}$/.test(raw)) throw totpError('ADMIN_TOTP_NOT_CONFIGURED', 503);
  let buffer = 0;
  let bits = 0;
  const output = [];
  for (const character of raw) {
    buffer = ((buffer << 5) | ALPHABET.indexOf(character)) >>> 0;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
    }
  }
  if (output.length < 16) throw totpError('ADMIN_TOTP_NOT_CONFIGURED', 503);
  return Buffer.from(output);
}

function codeAt(secret, counter) {
  const challenge = Buffer.alloc(8);
  challenge.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(TOTP_ALGORITHM, secret).update(challenge).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function configuration() {
  return {
    required: env.security.adminTotp.mode === 'required',
    configured: env.security.adminTotp.configured,
    provider: 'Google Authenticator',
    algorithm: TOTP_ALGORITHM.toUpperCase(),
    digits: TOTP_DIGITS,
    periodSeconds: TOTP_PERIOD_SECONDS
  };
}

function gateSessionFingerprint(uid = '', gateSession = '') {
  const safeSession = String(gateSession || '').trim();
  if (safeSession.length < 16 || safeSession.length > 120) return '';
  return crypto.createHash('sha256')
    .update(`shelby-admin-totp-session\u0000${String(uid || '').trim()}\u0000${safeSession}`)
    .digest('hex');
}

async function verifyAdminTotp({ uid = '', code = '', gateSession = '' } = {}) {
  const policy = configuration();
  if (!policy.configured) {
    if (!policy.required) return { verified: false, optional: true };
    throw totpError('ADMIN_TOTP_NOT_CONFIGURED', 503);
  }
  const candidate = String(code || '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(candidate)) throw totpError('ADMIN_TOTP_INVALID');
  const secret = decodeBase32(env.security.adminTotp.secret);
  const now = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  let matched = -1;
  for (const offset of [-1, 0, 1]) {
    const expected = codeAt(secret, now + offset);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) matched = now + offset;
  }
  secret.fill(0);
  if (matched < 0) throw totpError('ADMIN_TOTP_INVALID');
  const safeUid = String(uid || '').trim().slice(0, 160);
  const sessionFingerprint = gateSessionFingerprint(safeUid, gateSession);
  const { db } = initFirebaseAdmin();
  if (!db || !safeUid) throw totpError('ADMIN_TOTP_UNAVAILABLE', 503);
  const reference = db.collection('storeAdminTotpState').doc(crypto.createHash('sha256').update(safeUid).digest('hex'));
  let replayed = false;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const previous = snapshot.exists ? snapshot.data() || {} : null;
    const lastCounter = Number(previous?.lastCounter || 0);
    if (lastCounter > matched) throw totpError('ADMIN_TOTP_REPLAY');
    if (lastCounter === matched) {
      const previousFingerprint = String(previous?.lastGateSessionHash || '');
      if (!sessionFingerprint || !/^[a-f0-9]{64}$/.test(previousFingerprint)
        || !crypto.timingSafeEqual(Buffer.from(previousFingerprint), Buffer.from(sessionFingerprint))) {
        throw totpError('ADMIN_TOTP_REPLAY');
      }
      replayed = true;
      return;
    }
    transaction.set(reference, {
      lastCounter: matched,
      verifiedAt: Date.now(),
      ...(sessionFingerprint ? { lastGateSessionHash: sessionFingerprint } : {})
    }, { merge: false });
  });
  return {
    verified: true,
    replayed,
    method: 'totp-rfc6238',
    provider: 'Google Authenticator',
    counter: matched
  };
}

module.exports = { configuration, verifyAdminTotp };
