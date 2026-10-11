'use strict';

// Run locally in a trusted, interactive terminal. Never save this output to source control.
const crypto = require('node:crypto');

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Bu araç yalnızca güvenli, etkileşimli bir terminalde çalıştırılabilir.');
  process.exitCode = 1;
} else {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function base32(bytes) {
    let carry = 0;
    let bits = 0;
    let output = '';
    for (const byte of bytes) {
      carry = (carry << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        output += alphabet[(carry >>> bits) & 31];
      }
      carry &= (1 << bits) - 1;
    }
    if (bits) output += alphabet[(carry << (5 - bits)) & 31];
    return output;
  }
  function gate() {
    const password = crypto.randomBytes(36).toString('base64url');
    const salt = crypto.randomBytes(32);
    const hash = crypto.scryptSync(password.normalize('NFKC'), salt, 32, {
      N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
    }).toString('hex');
    return { password, salt: salt.toString('hex'), hash };
  }
  const four = gate();
  const five = gate();
  const totp = base32(crypto.randomBytes(32));
  const result = [
    'ZENTRA STORE - yeni güvenlik bilgileri (özel olarak saklayın, hiçbir dosyaya commit etmeyin)',
    '',
    `4. güvenlik şifresi (Render ENV DEĞİL): ${four.password}`,
    `5. güvenlik şifresi (Render ENV DEĞİL): ${five.password}`,
    '',
    `ADMIN_GATE_FOUR_SALT_HEX=${four.salt}`,
    `ADMIN_GATE_FOUR_HASH_HEX=${four.hash}`,
    `ADMIN_GATE_FIVE_SALT_HEX=${five.salt}`,
    `ADMIN_GATE_FIVE_HASH_HEX=${five.hash}`,
    `ADMIN_GATE_SIGNING_SECRET=${crypto.randomBytes(64).toString('hex')}`,
    `ADMIN_TOTP_SECRET_BASE32=${totp}`,
    `STORE_KEY_ENCRYPTION_SECRET=${crypto.randomBytes(64).toString('hex')}`,
    '',
    'Google Authenticator: aşağıdaki otpauth URI değerini uygulamaya manuel ekleyin:',
    `otpauth://totp/ZENTRA%20STORE:admin?secret=${totp}&issuer=ZENTRA%20STORE&algorithm=SHA1&digits=6&period=30`,
    '',
    'UYARI: Eski şifreli stok kayıtları için STORE_KEY_DECRYPTION_KEYS_JSON içine eski şifreleme anahtarını',
    'güvenli olarak eklemeden STORE_KEY_ENCRYPTION_SECRET ve STORE_KEY_ACTIVE_KEY_ID değerlerini değiştirmeyin.',
    'Mevcut STORE_KEY_FINGERPRINT_SECRET, stok parmak izi kayıtları taşınmadan değiştirilmemelidir.'
  ];
  process.stdout.write(result.join('\n') + '\n');
}
