'use strict';

const { CATEGORY_VISIBILITY_KEYS, LEGACY_GAME_CATEGORY_KEYS } = require('../../public/js/store/catalog-schema.mjs');
const { MAX_IMAGE_BASE64 } = require('./storeProductImages');
const { TOPUP_LIMITS } = require('./shopierWallet');

const text = (max) => (value) => typeof value === 'string' && value.length <= max;
const integer = (min, max) => (value) => Number.isSafeInteger(value) && value >= min && value <= max;
const boolean = (value) => typeof value === 'boolean';
const object = (fields) => (value) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).every(([key, item]) => Object.hasOwn(fields, key) && fields[key](item));
const list = (check, max) => (value) => Array.isArray(value) && value.length <= max && value.every(check);
const date = (value) => value === null || integer(0, 8640000000000000)(value) || text(40)(value);
const features = (value) => text(6500)(value) || list(text(160), 40)(value);
const cartLine = object({ productId: text(80), planKey: text(40), quantity: integer(1, 5), expectedUnitPriceKurus: integer(1, 100000000) });
const cart = list(cartLine, 20);
const planFields = { key: text(40), label: text(50), duration: text(50), priceKurus: integer(1, 100000000), active: boolean };
const productFields = { name: text(80), platform: text(20), game: text(30), category: text(50), categoryKey: text(40),
  image: text(500), description: text(240), features, featured: boolean, badgeKey: text(40), badge: text(80),
  active: boolean, archived: boolean, automaticEnabled: boolean, telegramEnabled: boolean, sortOrder: integer(0, 10000), tags: list(text(40), 24) };
const productCreate = object({ ...productFields, imageUpload: object({ data: text(MAX_IMAGE_BASE64) }), id: text(80), inventoryType: text(20), fulfillmentMode: text(30), plans: list(object(planFields), 12) });
const planMap = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 12
  && Object.entries(value).every(([key, entry]) => /^[a-z0-9-]{1,40}$/.test(key) && object(planFields)(entry));
const productPatch = object({ ...productFields, plans: planMap });
const link = object({ id: text(80), platform: text(20), title: text(48), description: text(80), url: text(500), enabled: boolean });
const promotion = object({ type: text(20), title: text(100), value: integer(1, 100000000), minimumSubtotalKurus: integer(0, 100000000),
  maxDiscountKurus: integer(0, 100000000), startsAt: date, endsAt: date, usageLimit: integer(0, 1000000), perUserLimit: integer(1, 100),
  platforms: list(text(20), 2), productIds: list(text(80), 50), active: boolean, visibleInWallet: boolean, createOnly: boolean });
const inventoryKey = (value) => text(512)(value) || object({ username: text(160), login: text(160), password: text(256) })(value);
const inventoryFields = { productId: text(80), planKey: text(40), keys: list(inventoryKey, 200), idempotencyKey: text(160) };
const content = object({ maintenance: boolean,
  announcement: object({ enabled: boolean, title: text(100), message: text(500), tone: text(20), ctaLabel: text(40), ctaTarget: text(80) }),
  services: object({ automaticDelivery: boolean, telegramSupport: boolean, balancePayment: boolean }),
  support: object({ telegramUsername: text(80) }), home: object({ title: text(100), message: text(500) }),
  categoryVisibility: object(Object.fromEntries([...CATEGORY_VISIBILITY_KEYS, ...LEGACY_GAME_CATEGORY_KEYS].map((key) => [key, boolean]))), quickLinks: list(link, 16) });
const CONTRACTS = [
  ['POST', /^\/api\/admin\/store\/shopier\/jobs\/[^/]+\/retry$/, object({})],
  ['POST', /^\/api\/payments\/shopier\/create$/, object({ items: cart, idempotencyKey: text(160), promotionCode: text(32) })],
  ['POST', /^\/api\/payments\/shopier\/topups$/, object({ amountKurus: integer(TOPUP_LIMITS.minKurus, TOPUP_LIMITS.maxKurus), idempotencyKey: text(160) })],
  ['POST', /^\/api\/admin\/store\/orders\/[^/]+\/shopier\/(?:reconcile|close)$/, object({})],
  ['POST', /^\/api\/profile\/update$/, object({ firstName: text(50), lastName: text(50), username: text(20), birthDate: text(10) })],
  ['POST', /^\/api\/auth\/login$/, object({ identifier: text(254), password: text(4096) })],
  ['POST', /^\/api\/auth\/password-reset$/, object({ identifier: text(254) })],
  ['POST', /^\/api\/auth\/session$/, object({ idToken: text(16384), remember: boolean })],
  ['POST', /^\/api\/auth\/admin\/gate\/step-email$/, object({ browserKey: object({ keyId: text(36), publicKey: object({ kty: text(4), crv: text(8), x: text(43), y: text(43) }) }) })],
  ['POST', /^\/api\/auth\/admin\/gate\/step-uid$/, object({ ticket: text(16384) })],
  ['POST', /^\/api\/auth\/admin\/gate\/step-(?:firebase-password|four)$/, object({ ticket: text(16384), password: text(4096) })],
  ['POST', /^\/api\/auth\/admin\/gate\/step-five$/, object({ ticket: text(16384), password: text(4096) })],
  ['POST', /^\/api\/auth\/admin\/gate\/step-six$/, object({ ticket: text(16384), totpCode: text(16) })],
  ['POST', /^\/api\/auth\/(?:logout|admin\/gate\/logout)$/, object({})],
  ['POST', /^\/api\/admin\/action-proof$/, object({ method: text(8), path: text(240), password: text(4096), bodyHash: (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) })],
  ['PATCH', /^\/api\/store\/profile\/avatar$/, object({ avatarId: text(40) })],
  ['PATCH', /^\/api\/store\/profile\/username$/, object({ username: text(80) })],
  ['PATCH', /^\/api\/store\/profile\/name$/, object({ firstName: text(80), lastName: text(80) })],
  ['PATCH', /^\/api\/store\/profile\/birth-date$/, object({ birthDate: text(20) })],
  ['POST', /^\/api\/store\/profile\/email-change\/prepare$/, object({ email: text(254) })],
  ['POST', /^\/api\/store\/orders$/, object({ items: cart, paymentMethod: text(20), idempotencyKey: text(160), promotionCode: text(32) })],
  ['POST', /^\/api\/store\/order-attempt\/cancel$/, object({ idempotencyKey: text(160) })],
  ['POST', /^\/api\/store\/orders\/[^/]+\/cancel$/, object({ reason: text(200) })],
  ['POST', /^\/api\/store\/promotions\/validate$/, object({ items: cart, code: text(32) })],
  ['POST', /^\/api\/store\/balance-codes\/redeem$/, object({ code: text(32) })],
  ['POST', /^\/api\/store\/restock-subscriptions$/, object({ productId: text(80), planKey: text(40) })],
  ['PATCH', /^\/api\/store\/notifications\/[^/]+\/read$/, object({})],
  ['POST', /^\/api\/admin\/store\/products$/, productCreate],
  ['PATCH', /^\/api\/admin\/store\/products\/[^/]+$/, productPatch],
  ['POST', /^\/api\/admin\/store\/products\/bulk$/, object({ updates: list(object({ productId: text(80), settings: productPatch }), 100) })],
  ['PATCH', /^\/api\/admin\/store\/orders\/[^/]+$/, object({ status: text(30), cancellationReason: text(500), refundReason: text(500), deliveryMessage: text(4000), manualDeliveryText: text(100000) })],
  ['PATCH', /^\/api\/admin\/store\/content$/, content],
  ['PUT', /^\/api\/admin\/store\/links$/, object({ links: list(link, 16) })],
  ['PUT', /^\/api\/admin\/store\/(?:promotions|balance-codes)\/[^/]+$/, promotion],
  ['POST', /^\/api\/admin\/store\/inventory\/(?:import|import-check)$/, object(inventoryFields)],
  ['POST', /^\/api\/admin\/store\/inventory\/(?:migrate-shared-pool|rotate-encryption)$/, object({ productId: text(80), planKey: text(40), limit: integer(1, 400) })],
  ['POST', /^\/api\/admin\/store\/inventory\/[^/]+\/(?:revoke|reveal)$/, object({ productId: text(80), planKey: text(40), storageSku: text(130), reason: text(500) })],
  ['PATCH', /^\/api\/admin\/store\/users\/[^/]+$/, object({ status: text(30), adminNote: text(1000) })],
  ['POST', /^\/api\/admin\/store\/wallet\/adjust$/, object({ uid: text(160), amountKurus: integer(-100000000, 100000000), type: text(30), reason: text(500), idempotencyKey: text(160) })],
  ['PUT', /^\/api\/admin\/store\/staff\/[^/]+$/, object({ email: text(254), role: text(40), active: boolean })]
];
function validateApiBody(method, path, body) {
  const contract = CONTRACTS.find(([verb, pattern]) => verb === method && pattern.test(path));
  return !contract || contract[2](body ?? {});
}
function apiBodyContract(req, res, next) {
  if (!validateApiBody(req.method, String(req.originalUrl || '').split('?')[0], req.body)) {
    return res.status(400).json({ ok: false, error: 'API_BODY_INVALID', message: 'Alanların biçimini, sınırlarını ve desteklenen bilgileri kontrol edin.', requestId: req.requestId });
  }
  return next();
}
function apiClientGuard(req, res, next) {
  const match = /^(?:premium-store|secure-admin)-v(\d+)$/.exec(String(req.headers['x-zentra-store-client'] || ''));
  const path = String(req.originalUrl || '').split('?')[0];
  const businessWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (path.startsWith('/api/store/') || path.startsWith('/api/payments/') || path.startsWith('/api/admin/store/') || path === '/api/profile/update');
  if (businessWrite && match && Number(match[1]) < 77) return res.status(409).json({ ok: false, error: 'CLIENT_UPDATE_REQUIRED', message: 'Mağaza güncellendi. İşlemi sürdürmek için sayfayı yenileyin.', requestId: req.requestId });
  return next();
}
module.exports = { apiBodyContract, apiClientGuard, validateApiBody, CONTRACTS };
