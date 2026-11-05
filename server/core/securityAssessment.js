'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const env = require('../config/env');
const { adminAccessCookiePolicy } = require('./adminAccessService');
function sourceDigest(root = path.resolve(__dirname, '../..')) {
  const hash = crypto.createHash('sha256');
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (['node_modules', '.git', 'dist-pages', 'test-results'].includes(entry.name)) continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (/\.(?:js|cjs|mjs|html|css|rules|yaml)$/.test(name) || ['package.json', 'package-lock.json', 'firestore.indexes.json', 'firebase.json', 'public/data/store-products.json', '.env.example'].includes(name)) hash.update(name).update('\0').update(fs.readFileSync(path.join(root, name))).update('\0');
    }
  }
  visit(''); return hash.digest('hex');
}
let sourceHash;
function validationEvidence() {
  try {
    sourceHash ||= sourceDigest();
    const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, '../../validation-evidence.json'), 'utf8'));
    if (evidence.source?.exitCode !== 0 || evidence.modules?.exitCode !== 0 || evidence.catalog?.exitCode !== 0 || evidence.sourceDigest !== sourceHash || !Number.isSafeInteger(evidence.checkedAt) || Date.now() - evidence.checkedAt > 30 * 86400_000 || evidence.checkedAt > Date.now() + 60_000) return {};
    return evidence;
  } catch (_) { return {}; }
}
function assessSecurity({ configuration = {}, gateSecurity = {}, inventory = {}, connections = {}, backup = {}, req, res } = {}) {
  const evidence = validationEvidence(), cookie = adminAccessCookiePolicy();
  const gate = new Map((gateSecurity.checks || []).map(check => [check.key, check.ok === true]));
  const regression = evidence.regression?.exitCode === 0 && evidence.regression?.failed === 0 && evidence.regression?.passed > 0;
  const audit = evidence.dependencies;
  const rows = [];
  function add(key, label, status, detail, critical = false) {
    rows.push({ key, label, status: status === true ? 'passed' : status === false ? 'failed' : status,
      detail, critical, weight: 5, earned: status === true || status === 'passed' ? 5 : status === 'partial' ? 2.5 : 0,
      ok: status === true || status === 'passed' });
  }
  add('admin-auth', 'Yönetici kimliği ve çok adımlı giriş', req?.adminPolicy?.active === true && !!req?.adminAccess && gate.get('signed-access') === true, 'Bu istekte doğrulanan yönetici oturumu ve sunucu giriş politikası.', true);
  add('rbac', 'Rol ve API erişim denetimleri', regression ? true : 'unverified', 'Kaynak özeti eşleşen yetkisiz erişim regresyonları.');
  add('sessions', 'Oturum ve token koruması', cookie.httpOnly && cookie.secure && cookie.sameSite === 'strict' && configuration.adminTotpConfigured === true, 'HttpOnly, Secure, SameSite ve zorunlu TOTP yapılandırması.', true);
  add('passwords', 'Parola ve kritik işlem doğrulaması', regression && gate.get('firebase-password') === true, 'Firebase parola doğrulaması, kısa ömürlü ve tek kullanımlık işlem onayı.');
  add('database', 'Veritabanı bağlantısı ve istemci erişim kuralı', connections.storageReady === true && /allow read, write: if false/.test(fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8')) ? 'partial' : false, 'Sunucu okuma bağlantısı ve paketteki kapalı istemci kuralı kontrol edilir. Yayımlanan kurallar ve servis hesabının en az yetkileri ayrıca doğrulanmalıdır.', true);
  add('admin-panel', 'Yönetim paneli erişim sınırı', regression ? true : 'unverified', 'Kapı atlama, rol iptali ve işlem kanıtı regresyonları.');
  add('rate-limit', 'Dağıtık istek ve brute force koruması', configuration.rateLimitStore === 'firestore' && connections.storageReady === true ? true : ['memory', 'firestore'].includes(configuration.rateLimitStore) ? 'partial' : false, 'Yapılandırılan kalıcı depo için gerçek veritabanı erişimi de aranır. Bellek modu yalnızca tek sunucuda geçerlidir.');
  add('request-guards', 'XSS, CSRF ve enjeksiyon kontrolleri', regression ? true : 'unverified', 'Origin, JSON şemaları, imzalı istek ve zararlı giriş regresyonları.');
  const csp = String(res?.getHeader?.('Content-Security-Policy') || '');
  add('headers', 'Bu yanıtta güvenli HTTP başlıkları', !!csp && String(res?.getHeader?.('X-Content-Type-Options')) === 'nosniff', 'Yanıtın gerçek CSP ve nosniff başlıkları.');
  add('https', 'HTTPS bağlantısı', req?.secure === true ? true : env.nodeEnv === 'production' ? false : 'unverified', 'Bu isteğin TLS/proxy durumu; yerel HTTP üretim kanıtı sayılmaz.', true);
  add('secrets', 'Gizli anahtarlar ve şifreli kasa', configuration.keyVaultReady === true && !!configuration.keyVaultActiveKeyId && configuration.serviceAccountReady === true, 'Ayrı anahtarlar ve sunucu tarafındaki çalışma yapılandırması.', true);
  add('telegram', 'Telegram adres ve manuel ödeme sınırı', regression ? true : 'unverified', 'Resmî alan adı doğrulaması ve kayıtlı manuel ödeme referansı; bot iptal API’si kullanılmaz.');
  add('personal-data', 'Hassas veri ve teslimat kasası', configuration.keyVaultReady === true && regression, 'Şifreli teslimat, maskelenmiş kimlik ve yetkisiz erişim regresyonları.');
  add('logging', 'Log ve hata verisi koruması', regression ? true : 'unverified', 'Anahtar, parola ve sağlayıcı gövdesi sızıntısı regresyonları.');
  add('dependencies', 'Bağımlılık güvenlik taraması', audit?.verified === true ? (audit.vulnerabilities === 0) : 'unverified', audit?.verified ? `npm audit: ${audit.vulnerabilities} açık; ${new Date(audit.checkedAt).toISOString()}` : 'Güncel bağımlılık taraması doğrulanmadı.', audit?.verified && audit.critical > 0);
  add('audit', 'Kritik işlemler ve kalıcı silme denetimi', regression ? true : 'unverified', 'İşlemle aynı transaction içinde kayıt, korunan silme izi ve kısmi başarısızlık testleri.');
  add('backup', 'Yedekleme ve geri yükleme tatbikatı', backup.verified === true ? true : 'unverified', backup.verified === true ? `Ayrı projeye geri yüklenen ${backup.documents} belge checksum ile eşleşti. Son doğrulama: ${new Date(backup.verifiedAt).toISOString()}` : 'Son 30 günde imzalı ve ayrı bir projede checksum eşleşmesiyle doğrulanmış gerçek geri yükleme kaydı bulunamadı.');
  add('environment', 'Üretim ve ortam ayarları', configuration.ready === true && configuration.adminTransientStore === 'firestore', 'Gerekli ayarlar ve yeniden başlatmaya dayanıklı yönetim oturum deposu.');
  add('app-check', 'Zorunlu uygulama doğrulaması', configuration.appCheckMode === 'enforce' && configuration.appCheckConfigured === true, 'Monitor modu doğrulanmış istemci zorunluluğu sağlamaz.');
  const remedies = {
    'admin-auth': 'Güncel yönetici hesabıyla altı giriş adımını tamamlayın; hesap ve imzalı kapı yapılandırmasını kontrol edin.',
    rbac: 'Bu sürüm için npm run build doğrulamasını tamamlayın; personel rollerini en az yetkiyle sınırlandırın.',
    sessions: 'HTTPS, zorunlu TOTP ve ayrı yönetici imza anahtarlarını yapılandırın.',
    passwords: 'Firebase parola doğrulamasını ve bu sürümün işlem onayı regresyonlarını doğrulayın.',
    database: 'firestore.rules ve indeksleri doğru projeye yayımlayın; servis hesabı IAM izinlerini ayrıca doğrulayın.',
    'admin-panel': 'Bu sürümün kapı atlama, rol iptali ve işlem onayı testlerini çalıştırın.',
    'rate-limit': 'RATE_LIMIT_STORE=firestore kullanın ve hizmet hesabının bu depoya bağlantısını doğrulayın.',
    'request-guards': 'Bu kaynak sürümünün XSS, CSRF ve istek şeması testlerini çalıştırın.',
    headers: 'SECURITY_CSP_STRICT=1 ve HTTPS yanıt başlıklarını gerçek yayın adresinde kontrol edin.',
    https: 'Yayını HTTPS üzerinden açın; PUBLIC_BASE_URL ve güvenilen proxy yapılandırmasını doğrulayın.',
    secrets: 'Mevcut stok şifreleme anahtarlarını koruyarak eksik servis hesabı/kasa ayarlarını tamamlayın.',
    telegram: 'Telegram adresini ve manuel ödeme/iade referansı iş akışını kontrol edin.',
    'personal-data': 'Kasa anahtarlarını ve yetkisiz teslimat erişimi testlerini doğrulayın.',
    logging: 'Bu sürümün hassas veri sızıntısı regresyonlarını çalıştırın.',
    dependencies: 'npm audit --omit=dev çalıştırın ve bulunan bağımlılık açıklarını gidermeden yüksek güvenlik seviyesi bildirmeyin.',
    audit: 'Bu sürümün transaction denetimi ve korunan silme kayıtlarını doğrulayın.',
    backup: 'Gerçek yedeği ayrı projeye geri yükleyip npm run security:verify-restore ile karşılaştırın.',
    environment: 'Eksik ortam değişkenlerini tamamlayın; ADMIN_TRANSIENT_STORE=firestore bağlantısını doğrulayın.',
    'app-check': 'Gerçek site anahtarını ve izinli alan adlarını yapılandırıp istemci tokenlarını doğruladıktan sonra APP_CHECK_MODE=enforce yapın.'
  };
  for (const row of rows) if (!row.ok) row.remediation = remedies[row.key] || 'Kontrol ayrıntısındaki eksikliği doğrulayın.';
  const failed = rows.filter(row => row.status === 'failed'), unverified = rows.filter(row => row.status === 'unverified');
  const critical = failed.filter(row => row.critical).length;
  const calculated = Math.round(100 * rows.reduce((total, row) => total + row.earned, 0) / rows.reduce((total, row) => total + row.weight, 0));
  const score = Math.min(calculated, critical ? 60 : 100);
  return { score, target: '98–99', ready: failed.length === 0 && unverified.length === 0,
    level: critical ? 'kritik' : failed.length || unverified.length || score < 98 ? 'uyarı' : 'kontroller başarılı',
    checkedAt: Date.now(), controlCount: rows.length, passedCount: rows.filter(row => row.ok).length,
    failedCount: failed.length, unverifiedCount: unverified.length, criticalCount: critical,
    pendingCount: rows.filter(row => !row.ok).length, scope: 'Çalışma anı kontrolleri ve kaynak özeti eşleşen kontrollü testler. Penetrasyon testi veya mutlak güvenlik garantisi değildir.', checks: rows };
}
module.exports = { assessSecurity, sourceDigest, validationEvidence };
