'use strict';

const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const { shopierFixture } = require('./helpers/shopier-fixture.cjs');
const firebaseSdk = require('./helpers/browser-firebase.cjs');
const output = path.resolve(process.env.SHOPIER_BROWSER_OUTPUT || 'test-results/shopier');
async function main() {
  fs.mkdirSync(output, { recursive: true });
  let app, provider, browser;
  const errors = [], results = { livePayments: 0, liveRefunds: 0, cases: [] };
  const completed = [];
  try {
    app = await applicationFixture({ shopier: true }); provider = shopierFixture();
    const inventory = require('../server/core/storeInventoryService'), jobs = require('../server/core/shopierJobs');
    const product = require('../server/core/storeCatalog').STORE_CATALOG.products.find((row) => row.id === 'kingmod'), plan = product.plans[0];
    await inventory.importInventory({ productId: product.id, planKey: plan.key, keys: ['SHOPIER-UI-KEY-ONE-2026', 'SHOPIER-UI-KEY-TWO-2026', 'SHOPIER-UI-KEY-THREE-2026'], actor: { uid: 'owneruid' }, idempotencyKey: 'shopier-browser-seed-123456' });
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : { channel: 'chrome' }),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], env: { ...process.env,
        ...(process.env.CHROMIUM_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.CHROMIUM_LIBRARY_PATH } : {}) } });
    async function context(viewport, identity = { uid: 'member', email: 'member@zentra.invalid', token: app.idToken('member') }, mobile = false) {
      const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce', ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      await ctx.route('https://www.gstatic.com/firebasejs/**', (route) => route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: firebaseSdk }));
      await ctx.route('https://www.shopier.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="tr"><title>Mock Shopier</title><body>İzole Shopier ödeme sayfası. Gerçek tahsilat yapılmaz.</body></html>' }));
      await ctx.addInitScript((value) => { globalThis.__qaIdentity = value; }, identity);
      ctx.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
      return ctx;
    }
    async function prepareCart(page) {
      await page.goto(app.origin + '/#product/' + product.id, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.dataset.storefrontStatus === 'ready');
      await page.waitForFunction(() => document.getElementById('purchaseModal').getAttribute('aria-hidden') === 'false');
      await page.locator(`[data-purchase-plan="${plan.key}"]`).click(); await page.locator('#addToCartButton').click();
      await page.evaluate(() => { location.hash = '#account/cart'; });
      await page.locator('#customerViewCart').waitFor({ state: 'visible' });
    }
    for (const [name, viewport, mobile] of [['desktop', { width: 1440, height: 1000 }, false], ['mobile', { width: 390, height: 844 }, true]]) {
      const ctx = await context(viewport, undefined, mobile), page = await ctx.newPage();
      await prepareCart(page); await page.waitForFunction(() => !document.getElementById('shopierCheckoutButton').disabled);
      assert.equal(await page.locator('#checkoutButton').isVisible(), true); assert.equal(await page.locator('#telegramCheckoutButton').isVisible(), true);
      const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
        button: document.getElementById('shopierCheckoutButton').getBoundingClientRect().toJSON() }));
      assert(layout.width <= layout.viewport + 1); assert(layout.button.width >= 150); assert(layout.button.height >= 44);
      await page.locator('#cartFooter').screenshot({ path: path.join(output, name + '-checkout.png') });
      let payload;
      // Capture the real API response before forwarding it: navigation can discard its CDP response body.
      await page.route('**/api/payments/shopier/create', async (route) => {
        const response = await route.fetch(); payload = await response.json(); await route.fulfill({ response });
      });
      await page.locator('#shopierCheckoutButton').click(); await page.waitForURL('https://www.shopier.com/**');
      assert.equal(payload.order.paymentState, 'pending'); assert.equal(payload.order.deliveryVisible, false);
      await page.goto(app.origin + '/odeme/sonuc?order=' + payload.order.id + '&status=paid', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('paymentStateTitle').textContent === 'Ödeme sonucu bekleniyor');
      assert.equal(await page.locator('#continuePayment').isVisible(), true);
      const remote = provider.paid(payload.order.shopier.productId), signed = provider.signed('order.created', remote);
      const hook = await fetch(app.origin + '/api/payments/shopier/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'shopier-signature': signed.signature, 'shopier-event': 'order.created' }, body: signed.raw });
      assert.equal(hook.status, 200);
      for (const [jobPath, row] of [...app.db.records]) if (jobPath.startsWith('shopierJobs/') && row.kind === 'order.created' && row.resourceId === remote.id) await jobs.processShopierJob(app.db, app.db.doc(jobPath));
      await jobs.processShopierJob(app.db, app.db.collection('shopierJobs').doc('delivery_' + payload.order.id));
      await page.locator('#refreshPayment').click(); await page.waitForFunction(() => document.getElementById('paymentStateTitle').textContent === 'Ödemeniz ve teslimatınız hazır');
      assert.equal(await page.locator('#continuePayment').isVisible(), false); assert.equal(await page.locator('#paymentProviderId').innerText(), remote.id);
      await page.screenshot({ path: path.join(output, name + '-result.png'), fullPage: true });
      await page.goto(app.origin + '/odeme/iptal?order=' + payload.order.id, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('paymentStatus').textContent === 'Ödeme doğrulandı');
      assert.equal(app.db.records.get('storeOrders/' + payload.order.id).paymentState, 'paid');
      completed.push({ id: payload.order.id, providerId: remote.id });
      results.cases.push({ name, checkout: true, pendingPageRejectsSpoofedSuccess: true, signedWebhook: true, delivery: true, cancelPageDoesNotCancelPaidOrder: true, layout });
      await ctx.close();
    }
    const mobile = await context({ width: 390, height: 844 }, undefined, true), page = await mobile.newPage();
    await page.goto(app.origin, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => document.documentElement.dataset.storefrontStatus === 'ready');
    const categories = page.locator('#gameCategories');
    const row = await categories.evaluate((node) => { const nodes = [...node.querySelectorAll('.game-category')].filter((entry) => !entry.hidden); return { scroll: node.scrollWidth, width: node.clientWidth, tops: nodes.map((entry) => entry.getBoundingClientRect().top) }; });
    assert(row.scroll > row.width); assert(Math.max(...row.tops) - Math.min(...row.tops) < 1);
    await categories.evaluate((node) => { node.scrollLeft = 0; node.scrollIntoView({ block: 'center', behavior: 'instant' }); });
    const point = await categories.evaluate((node) => { const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width * .75, y: rect.top + rect.height / 2 }; });
    const cdp = await mobile.newCDPSession(page); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - i * 24, y: point.y }] }); await new Promise((resolve) => setTimeout(resolve, 24)); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForFunction(() => document.getElementById('gameCategories').scrollLeft > 0);
    for (const [category, productId] of [['codm-ios', 'ios-cloud-codm'], ['codm-android', 'android-gbd-codm']]) {
      await page.locator(`#gameCategories [data-filter="${category}"]`).click(); assert.deepEqual(await page.locator('[data-store-product]').evaluateAll((nodes) => nodes.map((node) => node.dataset.storeProduct)), [productId]);
    }
    results.cases.push({ name: 'categories', horizontalTouch: true, separateIosAndroid: true }); await mobile.close();
    const session = await app.openAdmin(), admin = await context({ width: 1440, height: 1000 }, { uid: 'owneruid', email: 'owner@zentra.invalid', token: session.token });
    const cookies = new Map(session.cookie.split('; ').filter(Boolean).map((cookie) => { const i = cookie.indexOf('='); return [cookie.slice(0, i), cookie.slice(i + 1)]; }));
    await admin.addCookies([...cookies].map(([name, value]) => ({ name, value, url: app.origin, httpOnly: true, sameSite: 'Lax' })));
    const panel = await admin.newPage(); await panel.goto(app.origin + '/admin/', { waitUntil: 'domcontentloaded' }); await panel.locator('[data-panel="orders"]').first().click();
    await panel.locator('[data-admin-order]').first().waitFor(); await panel.locator('#orderPaymentFilter').selectOption('shopier'); assert.equal(await panel.locator('[data-admin-order]').count(), 2);
    await panel.locator('#orderSearch').fill(completed[0].providerId); assert.equal(await panel.locator('[data-admin-order]').count(), 1);
    assert((await panel.locator('.shopier-order-meta').innerText()).includes(completed[0].providerId));
    assert.equal(await panel.locator('[data-save-order]').isVisible(), false);
    await panel.screenshot({ path: path.join(output, 'admin-shopier-order.png'), fullPage: true });
    results.cases.push({ name: 'admin', paymentFilter: true, providerIdSearch: true, providerMetadata: true, paymentStatusReadOnly: true }); await admin.close();
    process.env.SHOPIER_ENABLED = 'false';
    const off = await context({ width: 390, height: 844 }), offPage = await off.newPage(); await prepareCart(offPage);
    assert.equal(await offPage.locator('#shopierCheckoutButton').isDisabled(), true); assert.equal(await offPage.locator('#telegramCheckoutButton').isDisabled(), false);
    results.cases.push({ name: 'disabled', cardCheckoutDisabled: true, existingMethodsPreserved: true }); await off.close();
    assert.deepEqual(errors, []); results.pageErrors = errors; results.passed = results.cases.length; results.failed = 0;
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally { if (browser) await browser.close(); if (provider) provider.close(); if (app) await app.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
