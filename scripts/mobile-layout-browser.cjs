'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const firebaseSdk = require('./helpers/browser-firebase.cjs');
const output = path.resolve(process.env.MOBILE_BROWSER_OUTPUT || 'test-results/mobile');
const profiles = [
  { name: 'iphone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', deviceScaleFactor: 2 },
  { name: 'android', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36', deviceScaleFactor: 3 },
];
const widths = [320, 360, 375, 390, 393, 412, 414, 430];

async function bounds(page, selectors, { tapTargets = false } = {}) {
  const rows = await page.evaluate(selectors => selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length).map(el => {
    const r = el.getBoundingClientRect();
    return { selector, x: r.x, right: r.right, width: r.width, height: r.height, clippedX: el.scrollWidth > el.clientWidth + 1, fontSize: getComputedStyle(el).fontSize, viewport: innerWidth };
  })), selectors);
  assert(rows.length, 'No visible elements to measure');
  for (const row of rows) {
    assert(row.x >= -1 && row.right <= row.viewport + 1, 'Clipped horizontal layout: ' + JSON.stringify(row));
    if (tapTargets) assert(row.width >= 43.9 && row.height >= 43.9, 'Small tap target: ' + JSON.stringify(row));
  }
  return rows;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  let app, browser;
  const errors = [], failedAssets = [], cases = [], metrics = new Map();
  try {
    app = await applicationFixture({ shopier: true, transientStore: 'memory', rateLimitStore: 'memory', appCheckMode: 'monitor' });
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : { channel: 'chrome' }), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], env: { ...process.env, ...(process.env.CHROMIUM_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.CHROMIUM_LIBRARY_PATH } : {}) } });
    const resetLimits = async () => { const { publicLimiter, apiLimiter } = require('../server/core/security'); await publicLimiter.resetKey('127.0.0.1'); await apiLimiter.resetKey('127.0.0.1'); };
    const contextFor = async (profile, width, { member = false, height = 844 } = {}) => {
      await resetLimits();
      const ctx = await browser.newContext({ viewport: { width, height }, userAgent: profile.userAgent, deviceScaleFactor: profile.deviceScaleFactor, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      await ctx.route('https://www.gstatic.com/firebasejs/**', r => r.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: firebaseSdk }));
      await ctx.route('https://encrypted-tbn0.gstatic.com/images**', r => r.fulfill({ contentType: 'image/webp', body: fs.readFileSync(path.join(__dirname, '../public/assets/images/zentra-mark.webp')) }));
      if (member) await ctx.addInitScript(identity => { globalThis.__qaIdentity = identity; }, { uid: 'member', email: 'member@zentra.invalid', token: app.idToken('member') });
      ctx.on('page', p => {
        p.on('pageerror', e => errors.push(e.message));
        p.on('response', r => { if (r.url().startsWith(app.origin + '/public/') && r.status() >= 400) failedAssets.push(new URL(r.url()).pathname); });
      });
      return ctx;
    };
    const ready = async page => {
      await page.waitForFunction(() => document.documentElement.dataset.storefrontStatus === 'ready' && document.body.dataset.authReady === 'true');
      await page.evaluate(() => document.fonts.ready);
    };
    for (const profile of profiles) for (const width of widths) {
      const ctx = await contextFor(profile, width), page = await ctx.newPage();
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' }); await ready(page);
      const layout = await bounds(page, ['.topbar', '.brand', '#guestActions', '.showcase-slider__viewport', '.showcase-slider__copy', '.showcase-slider__copy button', '.showcase-slider__toolbar', '.quick-links-section', '.showcase-social', '.product-card', '.mobile-nav']);
      await bounds(page, ['#loginBtn', '#registerBtn', '.showcase-slider__arrow', '.showcase-slider__autoplay', '.showcase-slider__copy button', '.mobile-nav button:not([hidden])'], { tapTargets: true });
      assert.equal(layout.find(r => r.selector === '.topbar').height, 61);
      const galleryHeight = layout.find(r => r.selector === '.showcase-slider__viewport').height;
      assert(galleryHeight >= 210 && galleryHeight <= 215, 'Mobile gallery is not compact');
      assert.equal(layout.find(r => r.selector === '.mobile-nav').height, 64);
      assert.equal(layout.find(r => r.selector === '.showcase-slider__copy button').clippedX, false);
      const scale = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth, zoom: visualViewport.scale, meta: document.querySelector('meta[name=viewport]').content, inputFont: getComputedStyle(document.getElementById('productSearch')).fontSize }));
      assert.equal(scale.width, width); assert(scale.overflow <= width + 1); assert.equal(scale.zoom, 1); assert.equal(scale.inputFont, '16px'); assert(!/maximum-scale|user-scalable=no/.test(scale.meta));
      metrics.set(profile.name + '-' + width, layout);
      await page.locator('[data-showcase-next]').click();
      await page.waitForFunction(() => document.querySelector('[data-showcase-current]').textContent === '02');
      await page.locator('[data-showcase-previous]').click();
      if ([320, 390, 414].includes(width)) await page.screenshot({ path: path.join(output, profile.name + '-home-' + width + '.png') });
      await page.locator('#loginBtn').click(); await page.locator('#loginIdentifier').waitFor({ state: 'visible' });
      await bounds(page, ['#authSheet .side-sheet', '#loginForm .form-field__input', '#authSheet .dialog-close']);
      await bounds(page, ['#authSheet .dialog-close', '#authLoginTab', '#authRegisterTab'], { tapTargets: true });
      await page.locator('#loginIdentifier').focus(); assert.equal(await page.evaluate(() => visualViewport.scale), 1);
      await page.locator('#authRegisterTab').click(); await page.locator('#registerForm').waitFor({ state: 'visible' });
      await bounds(page, ['#registerForm .form-field__input', '#registerForm .birth-field']);
      await page.locator('#authSheet button[data-close-layer]').click();
      cases.push({ name: profile.name + '-guest-' + width, home: true, carousel: true, authForms: true, compact: true });
      await ctx.close();
    }
    for (const width of widths) {
      const ios = metrics.get('iphone-' + width), android = metrics.get('android-' + width);
      assert.equal(ios.length, android.length);
      ios.forEach((row, i) => {
        assert.equal(row.selector, android[i].selector); assert.equal(row.fontSize, android[i].fontSize);
        for (const key of ['x', 'width', 'height']) assert(Math.abs(row[key] - android[i][key]) <= 1, `Device geometry differs at ${width}: ${row.selector}.${key}`);
      });
    }
    cases.push({ name: 'shared-iphone-android-layout', widths, matchingGeometryWithinPixels: 1, engine: 'Chromium emulation' });
    const catalog = (await app.request('/api/store/catalog')).body.catalog;
    const product = catalog.products.find(p => p.id === 'kingmod'), plan = product.plans[0];
    await require('../server/core/storeInventoryService').importInventory({ productId: product.id, planKey: plan.key, keys: ['MOBILE-LAYOUT-TEST-001', 'MOBILE-LAYOUT-TEST-002', 'MOBILE-LAYOUT-TEST-003'], actor: { uid: 'owneruid' }, idempotencyKey: 'mobile-layout-inventory' });
    for (const [profile, width, height] of [[profiles[0], 320, 844], [profiles[0], 390, 844], [profiles[1], 430, 844], [profiles[0], 844, 390]]) {
      const ctx = await contextFor(profile, width, { member: true, height }), page = await ctx.newPage();
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' }); await ready(page);
      await page.locator('#topBalanceButton').waitFor({ state: 'visible' });
      await bounds(page, ['.brand', '#topBalanceButton', '#accountButton'], { tapTargets: true });
      const originalBalance = await page.locator('#topBalanceValue').innerText();
      await page.locator('#topBalanceValue').evaluate(el => { el.textContent = '10.000.000.000,00 TL'; });
      const wideBalance = await bounds(page, ['.brand', '#topBalanceButton', '#accountButton']);
      assert(wideBalance[0].right <= wideBalance[1].x - 4 && wideBalance[1].right <= wideBalance[2].x - 4, 'Large balance overlaps the header controls');
      await page.locator('#topBalanceValue').evaluate((el, value) => { el.textContent = value; }, originalBalance);
      await page.locator('#accountButton').click(); await page.locator('#customerViewProfile').waitFor({ state: 'visible' });
      await bounds(page, ['.client-shell', '.client-header', '.client-nav', '.client-header__actions', '.account-page__wallet', '#accountTopupAmount', '#accountTopupButton']);
      await bounds(page, ['.client-nav button', '.screen-icon-button', '.account-topup__presets button'], { tapTargets: true });
      await page.locator('#accountTopupAmount').fill('250'); assert.equal(await page.evaluate(() => visualViewport.scale), 1);
      await page.locator('[data-customer-nav="orders"]').click(); await page.locator('#customerViewOrders').waitFor({ state: 'visible' });
      await bounds(page, ['.orders-page__summary', '.orders-page__search', '.orders-page__filters', '.orders-page__results']);
      await page.locator('.client-nav [data-customer-home]').click();
      await page.evaluate(id => { location.hash = '#product/' + id; }, product.id);
      await page.locator('#purchaseModal.is-open').waitFor(); await page.locator('#addToCartButton').waitFor({ state: 'visible' });
      await bounds(page, ['.product-detail', '.product-detail__header', '.product-detail__footer', '.product-detail__actions', '.product-gallery__viewport', '.detail-plan']);
      const footer = await page.locator('.product-detail__footer').boundingBox(); assert(footer.y >= 0 && footer.y + footer.height <= height + 1);
      await bounds(page, ['.product-gallery__arrow', '#addToCartButton'], { tapTargets: true });
      if (width === 390) await page.screenshot({ path: path.join(output, 'member-product-390.png') });
      await page.locator('#addToCartButton').click();
      await page.locator('.zentra-notice.is-visible').waitFor();
      await bounds(page, ['.zentra-notice', '.zentra-notice__close'], { tapTargets: true });
      await page.evaluate(() => { location.hash = '#account/cart'; }); await page.locator('.customer-cart-item').waitFor({ state: 'visible' });
      await bounds(page, ['.customer-cart-item', '.customer-cart-item__controls', '.customer-cart-item__remove', '.customer-quantity', '.cart-shopier-panel', '#shopierCheckoutButton', '#cartTopupButton']);
      await bounds(page, ['.customer-cart-item__remove', '.customer-quantity button'], { tapTargets: true });
      await page.locator('[data-cart-quantity="increase"]').click(); await page.waitForFunction(() => document.querySelector('.customer-quantity output').textContent === '2');
      if (width === 320) await page.screenshot({ path: path.join(output, 'member-cart-320.png') });
      cases.push({ name: profile.name + '-member-' + width + 'x' + height, wallet: true, account: true, orders: true, product: true, cartQuantity: true, landscape: width > height });
      await ctx.close();
    }
    const ctx = await contextFor(profiles[0], 390), page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 44, bottom: 34, left: 0, right: 0 } });
    await page.goto(app.origin, { waitUntil: 'domcontentloaded' }); await ready(page);
    const safe = await page.evaluate(() => ({ top: getComputedStyle(document.querySelector('.topbar')).paddingTop, nav: getComputedStyle(document.querySelector('.mobile-nav')).paddingBottom, header: document.querySelector('.topbar').offsetHeight, body: parseFloat(getComputedStyle(document.body).paddingTop) }));
    assert.equal(safe.top, '44px'); assert.equal(safe.nav, '39px'); assert.equal(safe.header, 105); assert.equal(safe.body, 105);
    await bounds(page, ['.brand', '#guestActions', '.showcase-slider__viewport', '.mobile-nav']);
    await page.setViewportSize({ width: 844, height: 390 });
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 21, left: 44, right: 44 } });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.page-shell')).marginLeft === '44px');
    await bounds(page, ['.brand', '#guestActions', '.showcase-slider__viewport', '.mobile-nav']);
    cases.push({ name: 'safe-area-and-orientation', portraitInsets: safe, landscapeInsets: { left: 44, right: 44, bottom: 21 } });
    await ctx.close();
    assert.deepEqual(errors, []); assert.deepEqual(failedAssets, []);
    const result = { passed: cases.length, failed: 0, engine: 'Chromium; iPhone/Android viewport, UA and touch emulation; physical Safari/Android not tested', livePayments: 0, errors, failedAssets, cases, homeMetrics: Object.fromEntries(metrics) };
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: result.passed, failed: 0, errors, failedAssets }));
  } catch (error) {
    for (const [i, ctx] of (browser?.contexts() || []).entries()) for (const [j, page] of ctx.pages().entries()) await page.screenshot({ path: path.join(output, `failure-${i}-${j}.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally { if (browser) await browser.close(); if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
