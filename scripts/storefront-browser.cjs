'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const firebaseSdk = require('./helpers/browser-firebase.cjs');
const output = path.resolve(process.env.STOREFRONT_BROWSER_OUTPUT || 'test-results/storefront');
async function main() {
  fs.mkdirSync(output, { recursive: true });
  let app, browser;
  const pageErrors = [], assetFailures = [], cases = [];
  const results = { livePayments: 0, liveRefunds: 0, productsChecked: 0, plansChecked: 0, cases };
  try {
    app = await applicationFixture({ transientStore: 'memory', rateLimitStore: 'memory', appCheckMode: 'monitor' });
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : { channel: 'chrome' }), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], env: { ...process.env, ...(process.env.CHROMIUM_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.CHROMIUM_LIBRARY_PATH } : {}) } });
    const resetLimits = async () => { const { publicLimiter, apiLimiter, strictLimiter } = require('../server/core/security'); await publicLimiter.resetKey('127.0.0.1'); await apiLimiter.resetKey('127.0.0.1'); await strictLimiter.resetKey('127.0.0.1'); };
    let ctx, page;
    for (const width of [320, 390, 768, 1440]) {
      await resetLimits();
      ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', ...(width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      await ctx.route('https://www.gstatic.com/firebasejs/**', r => r.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: firebaseSdk }));
      await ctx.route('https://encrypted-tbn0.gstatic.com/images**', r => r.fulfill({ contentType: 'image/webp', body: fs.readFileSync(path.resolve(__dirname, '../public/assets/images/zentra-mark.webp')) }));
      await ctx.addInitScript(identity => { globalThis.__qaIdentity = identity; }, { uid: 'member', email: 'member@zentra.invalid', token: app.idToken('member') });
      ctx.on('page', p => {
        p.on('pageerror', e => pageErrors.push(e.message));
        p.on('response', r => { if (r.url().startsWith(app.origin + '/public/') && r.status() >= 400) assetFailures.push(new URL(r.url()).pathname); });
      });
      page = await ctx.newPage();
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.dataset.storefrontStatus === 'ready');
      const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, meta: document.querySelector('meta[name=viewport]').content, textSelection: getComputedStyle(document.querySelector('#productSearchHint')).userSelect, contextMenuAllowed: document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) }));
      assert(layout.width <= layout.viewport + 1); assert(Math.abs(layout.viewport-(width<500?width/0.8:width))<=1); for(const key of ['initial-scale','minimum-scale','maximum-scale']) assert.ok(layout.meta.includes(key+'=0.8')); assert.notEqual(layout.textSelection, 'none'); assert(layout.contextMenuAllowed);
      await page.locator('#shoppingGuide summary').focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('#shoppingGuide').getAttribute('open'), '');
      await page.locator('#productSearch').fill('olmayan-urun-987'); await page.waitForFunction(() => !document.querySelector('[data-store-product]'));
      await page.locator('#clearSearch').click(); await page.locator('[data-store-product]').first().waitFor();
      await page.screenshot({ path: path.join(output, 'home-' + width + '.png') });
      cases.push({ name: 'home-' + width, requestedScale:0.8, keyboardGuide: true, searchRecovery: true, layout });
      if (width !== 1440) await ctx.close();
    }
    const catalog = (await app.request('/api/store/catalog')).body.catalog;
    const allowedFilters=['oxide-ios','oxide-android','pubg-ios','pubg-android','gbox-ios'];
    const categoryControls=await page.locator('#gameCategories [data-category-platform]').evaluateAll(nodes=>nodes.map(node=>node.dataset.filter).sort());
    assert.deepEqual(categoryControls,[...allowedFilters].sort());
    for(const key of allowedFilters){
      const expected=catalog.products.filter(product=>`${product.game}-${product.platform}`===key).map(product=>product.id).sort();
      await page.locator(`[data-filter="${key}"]`).click();
      await page.waitForFunction(count=>document.querySelectorAll('[data-store-product]').length===count,expected.length);
      assert.deepEqual((await page.locator('[data-store-product]').evaluateAll(nodes=>nodes.map(node=>node.dataset.storeProduct))).sort(),expected);
    }
    await page.locator('[data-filter="all"]').click();
    await page.waitForFunction(count=>document.querySelectorAll('[data-store-product]').length===count,catalog.products.length);
    cases.push({name:'permitted-categories',exactProducts:true,gamesAndGbox:true});
    for (const product of catalog.products) {
      await page.evaluate(id => { location.hash = '#product/' + id; }, product.id);
      await page.waitForFunction(id => document.querySelector('[data-product-gallery]')?.dataset.productGallery === id, product.id);
      if (product.id === 'ios-lion-pubg') {
        const selector = `[data-product-gallery="${product.id}"] .product-gallery__slide img`;
        await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(img => img.complete && img.naturalWidth > 0), selector);
        const logo = await page.locator(selector).first().evaluate(img => ({ path: new URL(img.currentSrc).pathname, width: img.naturalWidth, height: img.naturalHeight }));
        assert.equal(logo.path, product.image); assert.equal(logo.width, 600); assert.equal(logo.height, 399);
        await page.locator('.product-detail').screenshot({ path: path.join(output, product.id + '-original-logo.png') });
      }
      for (const plan of product.plans) {
        await page.locator(`[data-purchase-plan="${plan.key}"]`).click();
        await page.waitForFunction(label => document.getElementById('purchaseFooterPlan').textContent.includes(label), plan.label);
        assert.equal(Number((await page.locator('#purchaseFooterPrice').innerText()).replace(/\D/g,'')),plan.priceKurus);
        assert.equal(await page.locator('#addToCartButton').isVisible(), true);
        results.plansChecked++;
      }
      results.productsChecked++;
    }
    cases.push({ name: 'all-products-and-plans', products: results.productsChecked, plans: results.plansChecked });
    await resetLimits();
    const product = catalog.products.find(p => p.id === 'kingmod'), plan = product.plans[0];
    assert.deepEqual(pageErrors, []); assert.deepEqual(assetFailures, []);
    Object.assign(results, { pageErrors, assetFailures, passed: cases.length, failed: 0 });
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
  } catch (error) {
    for (const context of browser?.contexts() || []) for (const p of context.pages()) if (p.url().startsWith(app?.origin || 'invalid')) await p.screenshot({ path: path.join(output, 'failure-' + context.pages().indexOf(p) + '.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { if (browser) await browser.close(); if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
