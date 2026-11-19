'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const firebaseSdk = require('./helpers/browser-firebase.cjs');
const output = path.resolve(process.env.GBOX_BROWSER_OUTPUT || 'test-results/gbox');
async function main() {
  fs.mkdirSync(output, { recursive: true });
  let app, browser; const errors = [], failures = [], cases = [];
  try {
    app = await applicationFixture({ transientStore: 'memory', rateLimitStore: 'memory', appCheckMode: 'monitor' });
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : { channel: 'chrome' }), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], env: { ...process.env, ...(process.env.CHROMIUM_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.CHROMIUM_LIBRARY_PATH } : {}) } });
    for (const width of [320, 390, 768, 1440]) {
      const ctx = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce', ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
      await ctx.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: firebaseSdk }));
      await ctx.route('https://encrypted-tbn0.gstatic.com/images**', route => route.fulfill({ contentType: 'image/webp', body: fs.readFileSync(path.resolve(__dirname, '../public/assets/images/zentra-mark.webp')) }));
      await ctx.route('https://t.me/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Isolated contact destination</title>' }));
      await ctx.addInitScript(identity => { globalThis.__qaIdentity = identity; }, { uid: 'member', email: 'member@zentra.invalid', token: app.idToken('member') });
      const page = await ctx.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.url().startsWith(app.origin + '/public/') && response.status() >= 400) failures.push(new URL(response.url()).pathname); });
      async function layout(label, selectors) {
        const value = await page.evaluate(selectors => {
          const nodes = selectors.flatMap(selector => [...document.querySelectorAll(selector)]).filter(node => node.getClientRects().length);
          return { viewport: innerWidth, page: document.documentElement.scrollWidth, meta: document.querySelector('meta[name=viewport]').content,
            overflow: nodes.filter(node => { const r = node.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map(node => node.className) };
        }, selectors);
        assert(value.page <= value.viewport + 1, JSON.stringify(value)); assert.deepEqual(value.overflow, []);
        for (const field of ['initial-scale', 'minimum-scale', 'maximum-scale']) assert(value.meta.includes(field + '=0.8'));
        cases.push({ name: label + '-' + width, layout: value });
      }
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.dataset.storefrontStatus === 'ready');
      await page.locator('[data-filter="gbox-ios"]').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-store-product]').length === 2);
      assert.deepEqual((await page.locator('[data-store-product]').evaluateAll(nodes => nodes.map(node => node.dataset.storeProduct))).sort(), ['gbox-ipad', 'gbox-iphone']);
      await layout('catalog-devices', ['[data-store-product]', '#gameCategories']);
      if (width === 390) await page.screenshot({ path: path.join(output, 'gbox-catalog-390.png'), fullPage: false });
      for (const [id, device] of [['gbox-iphone', 'iPhone'], ['gbox-ipad', 'iPad']]) {
        await page.evaluate(id => { location.hash = '#product/' + id; }, id);
        await page.waitForFunction(id => document.querySelector('[data-product-gallery]')?.dataset.productGallery === id, id);
        assert.equal(await page.locator('#purchaseTitle').textContent(), `GBOX · ${device}`);
        assert.equal(await page.locator('[data-purchase-plan]').count(), 1);
        assert.match(await page.locator('#purchaseFooterPlan').textContent(), /Yıllık · 12 ay/);
        assert.equal(Number((await page.locator('#purchaseFooterPrice').textContent()).replace(/\D/g, '')), 75000);
        const image = page.locator('[data-product-gallery] .product-gallery__slide img').first();
        await image.evaluate(img => img.decode());
        assert.deepEqual(await image.evaluate(img => [img.naturalWidth, img.naturalHeight, getComputedStyle(img).objectFit]), [600, 600, 'contain']);
        await layout('detail-' + device, ['.product-detail', '.product-detail__footer', '.detail-plan', '.product-detail__actions']);
        if (width === 390) await page.screenshot({ path: path.join(output, id + '-detail-390.png'), fullPage: false });
        await page.locator('#addToCartButton').click();
      }
      await page.evaluate(() => { location.hash = '#account/cart'; });
      await page.locator('#customerViewCart').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('.customer-cart-item').length === 2);
      assert.equal(Number((await page.locator('#cartTotal').textContent()).replace(/\D/g, '')), 150000);
      assert.equal(await page.locator('#checkoutButton').isDisabled(), true);
      assert.equal(await page.locator('#telegramCheckoutButton').isEnabled(), true);
      await page.locator('[data-cart-quantity="increase"]').first().click();
      await page.waitForFunction(() => Number(document.getElementById('cartTotal').textContent.replace(/\D/g, '')) === 225000);
      await page.locator('[data-cart-quantity="decrease"]').first().click();
      await page.waitForFunction(() => Number(document.getElementById('cartTotal').textContent.replace(/\D/g, '')) === 150000);
      await layout('cart-quantity-and-channels', ['.customer-cart-item', '.customer-summary', '#telegramCheckoutButton', '.customer-quantity']);
      if (width === 390) await page.screenshot({ path: path.join(output, 'gbox-cart-390.png'), fullPage: false });
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/store/orders' && response.request().method() === 'POST');
      await page.locator('#telegramCheckoutButton').click();
      const result = await response; assert.equal(result.status(), 201); const payload = await result.json();
      assert.equal(payload.order.totalKurus, 150000); assert.equal(payload.order.status, 'awaiting_payment');
      assert.deepEqual(payload.order.items.map(item => item.productName).sort(), ['GBOX · iPad', 'GBOX · iPhone']);
      const stored = app.db.records.get('storeOrders/' + payload.order.id);
      assert.equal(stored.totalKurus, 150000); assert.equal(stored.paymentMethod, 'telegram');
      assert.equal(app.db.records.get('users/member').storeBalanceKurus, 50000);
      await page.evaluate(() => { location.hash = '#account/orders'; });
      await page.locator(`[data-order-card="${payload.order.id}"]`).waitFor();
      assert.match(await page.locator(`[data-order-card="${payload.order.id}"]`).textContent(), /GBOX · iPad/);
      await layout('persisted-order-history', ['.order-card', '.orders-page__summary']);
      cases.push({ name: 'telegram-purchase-' + width, persisted: true, exactTotal: true, noInventedDelivery: true });
      await ctx.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(failures, []);
    const result = { passed: cases.length, failed: 0, engine: 'Chromium; viewport and touch emulation', liveTransactions: 0, pageErrors: errors, assetFailures: failures, cases };
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { if (browser) await browser.close(); if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
