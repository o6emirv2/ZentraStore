'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const { shopierFixture } = require('./helpers/shopier-fixture.cjs');
let app, provider, service, store, jobs, validEnv;
const key = () => 'wallet-' + crypto.randomUUID();
const rows = (prefix) => [...app.db.records].filter(([path]) => path.startsWith(prefix));
const profile = () => app.db.records.get('users/member');
const balance = () => profile().storeBalanceKurus;
const local = (r) => app.db.records.get('storeOrders/' + r.order.id);
const input = (extra = {}) => ({ uid: 'member', authUser: app.users.get('member'), purpose: 'wallet_topup', amountKurus: 25000, idempotencyKey: key(), ...extra });
const pending = (extra) => service.createShopierPayment(input(extra));
function refund(remote, total, status = 'succeeded') { remote.refunds = [{ id: 'refund-' + remote.id, status, total }]; return remote; }
async function verified(result) { const remote = provider.paid(result.order.shopier.productId); await service.applyShopierOrder(remote); return remote; }
async function webhook(event, body, token) {
  const signed = provider.signed(event, body, token ? { token } : {});
  return fetch(app.origin + '/api/payments/shopier/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'shopier-event': event, 'shopier-signature': signed.signature }, body: signed.raw });
}
before(async () => {
  app = await applicationFixture({ shopier: true }); provider = shopierFixture();
  service = require('../server/core/shopierService'); store = require('../server/core/storeService'); jobs = require('../server/core/shopierJobs');
  validEnv = Object.fromEntries(Object.entries(process.env).filter(([n]) => /^(?:SHOPIER_|WEQ_PUBLIC)/.test(n)));
});
beforeEach(() => {
  for (const [path] of app.db.records) if (/^(?:storeOrders|shopier|storeInventory|storeDeliveries|audit|storeWalletLedger|storePromotions|storePromotionUsage)/.test(path)) app.db.records.delete(path);
  provider.products.clear(); provider.orders.clear(); provider.refunds.clear(); provider.calls.length = 0;
  for (const name of Object.keys(process.env)) if (/^(?:SHOPIER_|WEQ_PUBLIC)/.test(name)) delete process.env[name]; Object.assign(process.env, validEnv);
  Object.assign(profile(), { storeBalanceKurus: 50000, storeWalletDebtKurus: 0, storeAccountStatus: 'active' }); app.db.setFailure(false);
  require('../server/core/storeInventoryService').invalidateStockCache();
  for (const name of ['storeOrders','storeWalletLedger']) require('../server/core/firestorePagination').invalidateCreatedAtPageCache(name);
});
after(async () => { provider.close(); await app.close(); });
test('topup HTTP creates explicit store credit with zero stock and no premature credit or delivery', async () => {
  const r = await app.request('/api/payments/shopier/topups', { uid: 'member', method: 'POST', body: { amountKurus: 25000, idempotencyKey: key() } });
  assert.equal(r.status, 200); assert.equal(r.body.order.orderType, 'wallet_topup'); assert.equal(r.body.order.totalKurus, 25000); assert.deepEqual(r.body.order.items, []);
  assert.equal(balance(), 50000); assert.equal(rows('storeInventory/').length, 0); assert.equal(rows('storeDeliveries/').length, 0); assert.equal(rows('storeWalletLedger/').length, 0);
  assert.match(provider.calls.find(x => x.method === 'POST').body.description, /Bu işlem ürün satın almaz veya stok ayırmaz/);
});
for (const amountKurus of [undefined,9999,1000001,-1,0,10000.5,'25000',null]) test('topup rejects invalid amount ' + String(amountKurus), async () => {
  await assert.rejects(pending({ amountKurus }), { code: 'SHOPIER_TOPUP_AMOUNT_INVALID' }); assert.equal(provider.calls.length, 0); assert.equal(balance(), 50000);
});
test('topup schema rejects forged identity, totals, currency, coupon and product fields', async () => {
  for (const extra of [{ uid:'owneruid' },{ totalKurus:1 },{ currency:'USD' },{ promotionCode:'DISCOUNT' },{ purpose:'purchase' },{ items:[] }]) {
    const r=await app.request('/api/payments/shopier/topups',{uid:'member',method:'POST',body:{amountKurus:25000,idempotencyKey:key(),...extra}});assert.equal(r.status,400);
  } assert.equal(provider.calls.length,0);
});
test('topup requires authentication and rejects foreign origins', async () => {
  const body={amountKurus:25000,idempotencyKey:key()};assert.equal((await app.request('/api/payments/shopier/topups',{method:'POST',body})).status,401);
  assert.equal((await app.request('/api/payments/shopier/topups',{uid:'member',method:'POST',headers:{origin:'https://evil.invalid'},body})).status,403);
});
test('signed callback is durable before API verification and credits once without product delivery', async () => {
  const r=await pending(),remote=provider.paid(r.order.shopier.productId);assert.equal((await webhook('order.created',{id:remote.id})).status,200);assert.equal(balance(),50000);
  const [path]=rows('shopierJobs/').find(([,j])=>j.kind==='order.created');await jobs.processShopierJob(app.db,app.db.doc(path));
  assert.equal(balance(),75000);assert.equal(local(r).fulfillmentStatus,'BAKIYE_YUKLENDI');assert.equal(rows('storeWalletLedger/').length,1);assert.equal(rows('shopierPayments/').length,1);
  assert.equal(rows('storeDeliveries/').length,0);assert(!rows('shopierJobs/').some(([,j])=>j.kind==='delivery'));
});
test('forged and wrong-subscription signatures never credit', async () => {
  const r=await pending(),remote=provider.paid(r.order.shopier.productId);
  assert.equal((await webhook('order.created',{id:remote.id},crypto.randomBytes(32).toString('hex'))).status,401);
  assert.equal((await webhook('order.created',{id:remote.id},process.env.SHOPIER_REFUND_WEBHOOK_TOKEN)).status,400);assert.equal(balance(),50000);
});
test('successful-looking return URL is not payment evidence', async () => {const r=await pending();assert.equal((await fetch(app.origin+'/odeme/sonuc?order='+r.order.id+'&status=paid')).status,200);assert.equal(balance(),50000);assert.equal(local(r).paidAt,0);});
test('unpaid provider order stays pending and never credits', async () => {const r=await pending();await service.applyShopierOrder(provider.paid(r.order.shopier.productId,{paymentStatus:'unpaid'}));assert.equal(balance(),50000);assert.equal(local(r).paymentState,'pending');});
test('amount, currency and customer mismatches fail without financial writes', async () => {
  const r=await pending(),remote=provider.paid(r.order.shopier.productId);
  for(const [field,value,code] of [['totals',{...remote.totals,total:'0.01'},'SHOPIER_AMOUNT_MISMATCH'],['currency','USD','SHOPIER_CURRENCY_MISMATCH'],['shippingInfo',{email:'other@zentra.invalid'},'SHOPIER_CUSTOMER_MISMATCH']])await assert.rejects(service.applyShopierOrder({...remote,[field]:value}),{code});
  assert.equal(balance(),50000);assert.equal(rows('storeWalletLedger/').length,0);
});
test('concurrent duplicate confirmations credit exactly once', async () => {const r=await pending(),remote=provider.paid(r.order.shopier.productId);await Promise.all(Array.from({length:10},()=>service.applyShopierOrder(remote)));assert.equal(balance(),75000);assert.equal(rows('storeWalletLedger/').length,1);});
test('concurrent different topups preserve both credits', async () => {const a=await pending(),b=await pending({amountKurus:30000});await Promise.all([service.applyShopierOrder(provider.paid(a.order.shopier.productId)),service.applyShopierOrder(provider.paid(b.order.shopier.productId))]);assert.equal(balance(),105000);});
test('same-key creation is idempotent and cannot change the requested amount', async () => {const b=input(),r=await Promise.all(Array.from({length:5},()=>service.createShopierPayment(b)));assert.equal(new Set(r.map(x=>x.order.id)).size,1);assert.equal(provider.calls.filter(x=>x.method==='POST').length,1);await assert.rejects(service.createShopierPayment({...b,amountKurus:30000}),{code:'STORE_ORDER_CONFLICT'});});
test('lost remote creation response recovers the original listing', async () => {
  provider.failNext((_u,o)=>{provider.products.set('topup-lost',{id:'topup-lost',...JSON.parse(o.body),url:'https://www.shopier.com/topup-lost'});throw new TypeError('disconnected');});
  const r=await pending();assert.equal(r.order.shopier.state,'creation_uncertain');await service.recoverShopierProduct(r.order.id);assert.equal((await service.getShopierPayment({uid:'member',orderId:r.order.id})).order.shopier.productId,'topup-lost');assert.equal(provider.calls.filter(x=>x.method==='POST').length,1);
});
test('different provider payments cannot credit the same topup twice', async()=>{const r=await pending();await verified(r);await assert.rejects(service.applyShopierOrder(provider.paid(r.order.shopier.productId)),{code:'SHOPIER_PAYMENT_ALREADY_BOUND'});assert.equal(balance(),75000);});
test('full refund before first settlement never credits',async()=>{const r=await pending();await service.applyShopierOrder(refund(provider.paid(r.order.shopier.productId),'250.00'));assert.equal(balance(),50000);assert.equal(local(r).paymentState,'refunded');assert.equal(rows('storeWalletLedger/').length,0);});
test('partial refund before settlement credits only verified remaining funds',async()=>{const r=await pending();await service.applyShopierOrder(refund(provider.paid(r.order.shopier.productId),'50.00'));assert.equal(balance(),70000);});
test('pending refund holds initial credit until a verified outcome',async()=>{const r=await pending(),remote=refund(provider.paid(r.order.shopier.productId),'250.00','pending');await service.applyShopierOrder(remote);assert.equal(balance(),50000);remote.refunds[0].status='failed';await service.applyShopierOrder(remote);assert.equal(balance(),75000);});
test('partial completed plus additional pending refund cannot prematurely credit',async()=>{const r=await pending(),remote=provider.paid(r.order.shopier.productId);remote.refunds=[{id:'done',status:'succeeded',total:'50.00'},{id:'waiting',status:'pending',total:'200.00'}];await service.applyShopierOrder(remote);assert.equal(balance(),50000);});
test('concurrent repeated full refunds reverse the credit once',async()=>{const r=await pending(),remote=await verified(r);refund(remote,'250.00');await Promise.all(Array.from({length:6},()=>service.applyShopierOrder(remote)));assert.equal(balance(),50000);assert.equal(rows('storeWalletLedger/').length,2);});
test('stale callbacks cannot undo verified partial refunds',async()=>{const r=await pending(),remote=await verified(r),old=structuredClone(remote);await service.applyShopierOrder(refund(remote,'50.00'));await service.applyShopierOrder(old);assert.equal(balance(),70000);assert.equal(local(r).walletTopup.netAppliedKurus,20000);});
test('refund after funds are spent records debt, blocks spending and never produces negative balance',async()=>{const r=await pending(),remote=await verified(r);profile().storeBalanceKurus=5000;await service.applyShopierOrder(refund(remote,'250.00'));assert.equal(balance(),0);assert.equal(profile().storeWalletDebtKurus,20000);const a=await store.readAccount('member',app.users.get('member'));assert.equal(a.accountStatus,'purchase_blocked');assert.equal(a.walletTopupAllowed,true);});
test('later topup settles refund debt before adding spendable funds',async()=>{profile().storeBalanceKurus=0;profile().storeWalletDebtKurus=20000;const r=await pending();await verified(r);assert.equal(balance(),5000);assert.equal(profile().storeWalletDebtKurus,0);assert.equal(local(r).walletTopup.debtSettledKurus,20000);assert.equal((await store.readAccount('member',app.users.get('member'))).accountStatus,'active');});
test('administrator-blocked and suspended accounts cannot initiate new topups',async()=>{for(const status of ['suspended','purchase_blocked']){profile().storeAccountStatus=status;await assert.rejects(pending(),{code:'STORE_PURCHASE_BLOCKED'});}assert.equal(provider.calls.length,0);});
test('payment is credited to its owner even if the account is suspended after link creation',async()=>{const r=await pending();profile().storeAccountStatus='suspended';await verified(r);assert.equal(balance(),75000);assert.equal((await store.readAccount('member',app.users.get('member'))).accountStatus,'suspended');});
test('disabled or incomplete configuration blocks new topups',async()=>{process.env.SHOPIER_ENABLED='false';await assert.rejects(pending(),{code:'SHOPIER_DISABLED'});process.env.SHOPIER_ENABLED='true';process.env.SHOPIER_PAT='';await assert.rejects(pending(),{code:'SHOPIER_CONFIGURATION_INVALID'});});
test('existing links still settle when new payment creation is disabled',async()=>{const r=await pending();process.env.SHOPIER_ENABLED='false';await verified(r);assert.equal(balance(),75000);});
test('wallet capacity is checked before requesting card payment',async()=>{profile().storeBalanceKurus=require('../server/core/storeMoney').MAX_STORE_BALANCE_KURUS;await assert.rejects(pending(),{code:'STORE_BALANCE_RECORD_INVALID'});assert.equal(provider.calls.length,0);});
test('topup cannot enter product inventory delivery',async()=>{const r=await pending();await verified(r);await assert.rejects(service.deliverShopierOrder(r.order.id),{code:'SHOPIER_TOPUP_RECONCILE_REQUIRED'});assert.equal(rows('storeDeliveries/').length,0);});
test('topup records are visible to their owner and authorized admin only',async()=>{const r=await pending();await verified(r);assert.equal((await app.request('/api/payments/shopier/orders/'+r.order.id,{uid:'finance'})).status,404);const mine=await app.request('/api/store/orders',{uid:'member'});const record=mine.body.orders.find(x=>x.id===r.order.id);assert.equal(record.orderType,'wallet_topup');assert.equal(record.deliveryVisible,false);const admin=await app.openAdmin(),list=await app.request('/api/admin/store/orders',admin);assert.equal(list.body.orders.find(x=>x.id===r.order.id).walletTopup.netAppliedKurus,25000);});
test('zero-stock catalog separately advertises topup availability and limits',async()=>{const r=await app.request('/api/store/catalog');assert.equal(r.body.catalog.payments.shopier.topupAvailable,true);assert.deepEqual(r.body.catalog.payments.shopier.topupLimits,{minKurus:10000,maxKurus:1000000});assert.equal(rows('storeInventory/').length,0);});
test('wallet funding is excluded from product revenue and purchase totals',async()=>{const r=await pending();await verified(r);const s=require('../server/core/adminStoreService');const v=await s.getAdminOverview({permissions:['*']});assert.equal(v.metrics.grossRevenueKurus,0);assert.equal(v.metrics.deliveredRevenueKurus,0);const u=await s.resolveStoreUser('member@zentra.invalid');assert.equal(u.totalSpendKurus,0);assert.equal(u.orderCount,0);});
test('funding immediately invalidates admin wallet summaries',async()=>{const s=require('../server/core/adminStoreService');s.invalidateAdminStoreCaches();const before=await s.getWalletSummary();const r=await pending();await verified(r);assert.equal((await s.getWalletSummary()).liabilityKurus,before.liabilityKurus+25000);});
test('staff without wallet read permission cannot see refund debt',()=>{const {redactUserFinance}=require('../server/core/adminOverviewPolicy');assert.deepEqual(redactUserFinance({uid:'member',balanceKurus:100,walletDebtKurus:200},{permissions:['store.users.read']}),{uid:'member'});});
test('same resource id across order and refund events remains separately deduplicated',async()=>{assert.equal((await webhook('order.created',{id:'same-id'})).status,200);assert.equal((await webhook('refund.updated',{id:'same-id'})).status,200);assert.equal(rows('shopierWebhookReceipts/').length,2);});
test('durable reconciliation continues after finding an unpaid provider order',async()=>{const r=await pending();provider.paid(r.order.shopier.productId,{paymentStatus:'unpaid'});const ref=app.db.collection('shopierJobs').doc('reconcile_'+r.order.id);app.db.records.get(ref.path).availableAt=0;await jobs.processShopierJob(app.db,ref);const job=app.db.records.get(ref.path);assert.equal(job.completedAt,0);assert(job.availableAt>Date.now());assert.equal(balance(),50000);});
