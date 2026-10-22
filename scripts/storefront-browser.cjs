'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const { shopierFixture } = require('./helpers/shopier-fixture.cjs');
const firebaseSdk = require('./helpers/browser-firebase.cjs');
const output = path.resolve(process.env.STOREFRONT_BROWSER_OUTPUT || 'test-results/storefront');
async function main() {
  fs.mkdirSync(output, { recursive: true });
  let app, provider, browser;
  const pageErrors = [], assetFailures = [], cases = [];
  const results = { livePayments: 0, liveRefunds: 0, productsChecked: 0, plansChecked: 0, cases };
  try {
    app = await applicationFixture({ shopier: true, transientStore: 'memory', rateLimitStore: 'memory', appCheckMode: 'monitor' });
    provider = shopierFixture();
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : { channel: 'chrome' }), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], env: { ...process.env, ...(process.env.CHROMIUM_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.CHROMIUM_LIBRARY_PATH } : {}) } });
    const resetLimits = async () => { const { publicLimiter, apiLimiter } = require('../server/core/security'); await publicLimiter.resetKey('127.0.0.1'); await apiLimiter.resetKey('127.0.0.1'); };
    let ctx, page;
    for (const width of [320, 390, 768, 1440]) {
      await resetLimits();
      ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', ...(width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      await ctx.route('https://www.gstatic.com/firebasejs/**', r => r.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: firebaseSdk }));
      await ctx.route('https://encrypted-tbn0.gstatic.com/images**', r => r.fulfill({ contentType: 'image/webp', body: fs.readFileSync(path.resolve(__dirname, '../public/assets/images/zentra-mark.webp')) }));
      await ctx.route('https://www.shopier.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Isolated payment</title>' }));
      await ctx.addInitScript(identity => { globalThis.__qaIdentity = identity; }, { uid: 'member', email: 'member@zentra.invalid', token: app.idToken('member') });
      ctx.on('page', p => {
        p.on('pageerror', e => pageErrors.push(e.message));
        p.on('response', r => { if (r.url().startsWith(app.origin + '/public/') && r.status() >= 400) assetFailures.push(new URL(r.url()).pathname); });
      });
      page = await ctx.newPage();
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.dataset.storefrontStatus === 'ready');
      const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, meta: document.querySelector('meta[name=viewport]').content, textSelection: getComputedStyle(document.querySelector('#productSearchHint')).userSelect, contextMenuAllowed: document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) }));
      assert(layout.width <= layout.viewport + 1); assert.equal(layout.viewport, width); assert(!/user-scalable=no|maximum-scale/.test(layout.meta)); assert.notEqual(layout.textSelection, 'none'); assert(layout.contextMenuAllowed);
      await page.locator('#shoppingGuide summary').focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('#shoppingGuide').getAttribute('open'), '');
      await page.locator('#productSearch').fill('olmayan-urun-987'); await page.waitForFunction(() => !document.querySelector('[data-store-product]'));
      await page.locator('#clearSearch').click(); await page.locator('[data-store-product]').first().waitFor();
      await page.screenshot({ path: path.join(output, 'home-' + width + '.png') });
      cases.push({ name: 'home-' + width, zoomEnabled: true, keyboardGuide: true, searchRecovery: true, layout });
      if (width !== 1440) await ctx.close();
    }
    const catalog = (await app.request('/api/store/catalog')).body.catalog;
    for (const product of catalog.products) {
      await page.evaluate(id => { location.hash = '#product/' + id; }, product.id);
      await page.waitForFunction(id => document.querySelector('[data-product-gallery]')?.dataset.productGallery === id, product.id);
      for (const plan of product.plans) {
        await page.locator(`[data-purchase-plan="${plan.key}"]`).click();
        await page.waitForFunction(label => document.getElementById('purchaseFooterPlan').textContent.includes(label), plan.label);
        assert.equal(await page.locator('#purchaseTopupPanel').isVisible(), true);
        assert.equal(await page.locator('#addToCartButton').isVisible(), false);
        assert.match(await page.locator('#purchaseTopupButton').innerText(), /SHOPİER İLE BAKİYE YÜKLE/);
        results.plansChecked++;
      }
      results.productsChecked++;
    }
    cases.push({ name: 'all-products-and-plans', products: results.productsChecked, plans: results.plansChecked, separateTopup: true });
    await resetLimits();
    const product = catalog.products.find(p => p.id === 'kingmod'), plan = product.plans[0];
    const inventory = require('../server/core/storeInventoryService'), payments = require('../server/core/shopierService');
    const seed = async key => { await inventory.importInventory({ productId: product.id, planKey: plan.key, keys: [key], actor: { uid: 'owneruid' }, idempotencyKey: key }); await page.evaluate(() => window.dispatchEvent(new Event('pageshow'))); };
    await seed('BROWSER-STOCK-REFRESH-2026-001');
    await page.goto(app.origin + '/#product/' + product.id, { waitUntil: 'domcontentloaded' });
    await page.locator('#addToCartButton').waitFor({ state: 'visible' });
    for (const [record, row] of [...app.db.records]) if (record.startsWith('storeInventory/') && row.status === 'available') await inventory.revokeInventory({ productId: row.productId, planKey: row.planKey, itemId: record.split('/').at(-1), storageSku: record.split('/')[1], actor: { uid: 'owneruid' }, reason: 'Isolated stock refresh verification' });
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.locator('#purchaseTopupPanel').waitFor({ state: 'visible' }); assert.equal(await page.locator('#addToCartButton').isVisible(), false);
    cases.push({ name: 'foreground-stock-refresh', currentStockControlsActions: true });
    await seed('BROWSER-STOCK-PURCHASE-2026-002');
    const posts = { topups: 0, create: 0 }; let topup, purchase;
    await page.route('**/api/payments/shopier/topups', async route => { posts.topups++; const response = await route.fetch(); topup = (await response.json()).order; await route.fulfill({ response }); });
    await page.route('**/api/payments/shopier/create', async route => { posts.create++; const response = await route.fetch(); purchase = (await response.json()).order; await route.fulfill({ response }); });
    await page.goto(app.origin + '/#account/profile', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('accountTopupButton').disabled);
    await page.locator('#accountTopupAmount').fill('250'); await page.locator('#accountTopupButton').click(); await page.waitForURL('**/odeme/sonuc?order=*');
    assert.equal(topup.orderType, 'wallet_topup'); assert.deepEqual(topup.items, []);
    await page.goto(app.origin + '/#product/' + product.id, { waitUntil: 'domcontentloaded' }); await page.locator('#addToCartButton').waitFor({ state: 'visible' }); await page.locator('#addToCartButton').click();
    await page.evaluate(() => { location.hash = '#account/cart'; }); await page.waitForFunction(() => !document.getElementById('shopierCheckoutButton').disabled);
    assert.match(await page.locator('#shopierCheckoutButton').innerText(), /Ürün siparişini/);
    await page.locator('#shopierCheckoutButton').click(); await page.waitForURL('**/odeme/sonuc?order=*'); assert.equal(purchase.orderType, 'purchase'); assert.notEqual(purchase.id, topup.id);
    await page.goto(app.origin + '/#account/profile', { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => document.getElementById('accountTopupAmount').disabled && !document.getElementById('accountTopupButton').disabled);
    await page.locator('#accountTopupButton').click(); await page.waitForURL('**/odeme/sonuc?order=' + topup.id); assert.deepEqual(posts, { topups: 1, create: 1 });
    cases.push({ name: 'independent-payment-recovery', separateRecords: true, walletResumesWallet: true, noDuplicatePOST: true });
    await page.goto(app.origin + '/#account/orders', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-order-filter="topups"]').click(); await page.locator(`[data-order-card="${topup.id}"]`).waitFor(); assert.equal(await page.locator('#ordersList [data-order-card]').count(), 1);
    await page.locator('[data-order-filter="purchases"]').click(); await page.locator(`[data-order-card="${purchase.id}"]`).waitFor(); assert.equal(await page.locator('#ordersList [data-order-card]').count(), 1);
    assert.equal(await page.locator('#orderMetricTotal').innerText(), '1');
    cases.push({ name: 'separate-history-and-metrics', onlyProductCountedAsPurchase: true });
    const remote = provider.paid(topup.shopier.productId, { refunds: [{ id: 'pending-refund-123', total: '250.00', status: 'pending' }] });
    await payments.applyShopierOrder(remote);
    await page.goto(app.origin + '/odeme/sonuc?order=' + topup.id, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('paymentStateTitle').textContent === 'İade işlemi kontrol ediliyor');
    assert.equal(app.db.records.get('users/member').storeBalanceKurus, 50000);
    cases.push({ name: 'refund-review-is-not-success', noPrematureWalletCredit: true });
    await page.evaluate(() => import('/public/js/store/auth.js?v=zentra-ui-v84r1').then(m => m.logoutStore()));
    await page.waitForFunction(() => document.getElementById('paymentFacts').hidden && document.getElementById('paymentAmount').textContent === '—');
    assert.equal(await page.locator('#paymentItems li').count(), 0);
    cases.push({ name: 'payment-details-cleared-on-logout', noStaleAccountFacts: true });
    assert.deepEqual(pageErrors, []); assert.deepEqual(assetFailures, []);
    Object.assign(results, { pageErrors, assetFailures, passed: cases.length, failed: 0 });
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
  } catch (error) {
    for (const context of browser?.contexts() || []) for (const p of context.pages()) if (p.url().startsWith(app?.origin || 'invalid')) await p.screenshot({ path: path.join(output, 'failure-' + context.pages().indexOf(p) + '.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { if (browser) await browser.close(); if (provider) provider.close(); if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
