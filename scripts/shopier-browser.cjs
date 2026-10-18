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
      // Every browser context represents a distinct test client on the shared loopback IP.
      const { publicLimiter, apiLimiter } = require('../server/core/security');
      await publicLimiter.resetKey('127.0.0.1'); await apiLimiter.resetKey('127.0.0.1');
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
    const topups = [];
    for (const [name, viewport, touch] of [['desktop-wallet', {width:1440,height:1000}, false], ['mobile-wallet', {width:390,height:844}, true]]) {
      const ctx = await context(viewport, undefined, touch), walletPage = await ctx.newPage();
      await prepareCart(walletPage); await walletPage.locator('[data-cart-quantity="increase"]').click();
      assert.equal(await walletPage.locator('#shopierCheckoutButton').isDisabled(), false);
      assert.match(await walletPage.locator('#shopierCheckoutButton').innerText(), /bakiye yükle/);
      assert.match(await walletPage.locator('#shopierCheckoutStatus').innerText(), /stok ayırmaz/);
      await walletPage.locator('#shopierCheckoutButton').click(); await walletPage.locator('#accountTopupForm').waitFor({state:'visible'});
      const before = app.db.records.get('users/member').storeBalanceKurus, beforeCalls = provider.calls.length;
      await walletPage.locator('#accountTopupAmount').fill('99'); await walletPage.locator('#accountTopupButton').click();
      assert.equal(await walletPage.locator('#accountTopupAmount').getAttribute('aria-invalid'),'true'); assert.equal(provider.calls.length,beforeCalls);
      await walletPage.locator('[data-topup-amount="250"]').click();
      const layout = await walletPage.locator('#accountTopupForm').evaluate(form=>({viewport:innerWidth,width:document.documentElement.scrollWidth,button:form.querySelector('button[type=submit]').getBoundingClientRect().toJSON()}));
      assert(layout.width <= layout.viewport+1); assert(layout.button.height>=44);
      await walletPage.locator('#accountTopupForm').screenshot({path:path.join(output,name+'-form.png')});
      let payload;
      await walletPage.route('**/api/payments/shopier/topups',async route=>{const response=await route.fetch();payload=await response.json();await route.fulfill({response});});
      await walletPage.locator('#accountTopupButton').click();await walletPage.waitForURL('https://www.shopier.com/**');
      assert.equal(payload.order.orderType,'wallet_topup');assert.equal(payload.order.totalKurus,25000);assert.equal(app.db.records.get('users/member').storeBalanceKurus,before);
      await walletPage.goto(app.origin+'/odeme/sonuc?order='+payload.order.id+'&status=paid',{waitUntil:'domcontentloaded'});
      await walletPage.waitForFunction(()=>document.getElementById('paymentStateTitle').textContent==='Ödeme sonucu bekleniyor');
      const remote=provider.paid(payload.order.shopier.productId),signed=provider.signed('order.created',{id:remote.id});
      for(let duplicate=0;duplicate<2;duplicate++){
        const hook=await fetch(app.origin+'/api/payments/shopier/webhook',{method:'POST',headers:{'content-type':'application/json','shopier-signature':signed.signature,'shopier-event':'order.created'},body:signed.raw});assert.equal(hook.status,200);
      }
      for(const [jobPath,row] of [...app.db.records])if(jobPath.startsWith('shopierJobs/')&&row.kind==='order.created'&&row.resourceId===remote.id)await jobs.processShopierJob(app.db,app.db.doc(jobPath));
      assert.equal(app.db.records.get('users/member').storeBalanceKurus,before+25000);assert.equal(app.db.records.has('shopierJobs/delivery_'+payload.order.id),false);
      await walletPage.locator('#refreshPayment').click();await walletPage.waitForFunction(()=>document.getElementById('paymentStateTitle').textContent==='Bakiye yüklemeniz tamamlandı');
      await walletPage.locator('#paymentAccountLink').click();await walletPage.locator('#accountTopupForm').waitFor({state:'visible'});
      await walletPage.waitForFunction(expected=>Number(document.getElementById('accountBalance').textContent.replace(/[^0-9]/g,''))===expected,before+25000);
      await walletPage.waitForFunction(()=>!document.getElementById('accountTopupAmount').disabled);
      await walletPage.evaluate(()=>{location.hash='#account/orders';});const card=walletPage.locator(`[data-order-card="${payload.order.id}"]`);await card.waitFor();
      assert.match(await card.innerText(),/Mağaza bakiyesi yüklemesi/);assert.match(await card.innerText(),/Bakiye yüklendi/);
      results.cases.push({name,stockInsufficientCheckoutAvailable:true,invalidAmountBlocked:true,exactlyOnceCredit:true,returnRefreshesBalanceAndClearsPending:true,layout});topups.push(payload.order.id);await ctx.close();
    }
    const walletAdmin=await context({width:1440,height:1000},{uid:'owneruid',email:'owner@zentra.invalid',token:session.token});
    await walletAdmin.addCookies([...cookies].map(([name,value])=>({name,value,url:app.origin,httpOnly:true,sameSite:'Lax'})));
    const walletPanel=await walletAdmin.newPage();await walletPanel.goto(app.origin+'/admin/',{waitUntil:'domcontentloaded'});await walletPanel.locator('[data-panel="orders"]').first().click();await walletPanel.locator('[data-admin-order]').first().waitFor();
    await walletPanel.locator('#orderSearch').fill('bakiye');assert.equal(await walletPanel.locator('[data-admin-order]').count(),2);assert.match(await walletPanel.locator(`[data-admin-order="${topups[0]}"]`).innerText(),/Bakiye yüklendi/);assert.equal(await walletPanel.locator('[data-shopier-action="deliver"]').count(),0);
    results.cases.push({name:'wallet-admin',topupSearch:true,creditStatusVisible:true,productDeliveryUnavailable:true});await walletAdmin.close();
    process.env.SHOPIER_ENABLED = 'false';
    const off = await context({ width: 390, height: 844 }), offPage = await off.newPage(); await prepareCart(offPage);
    assert.equal(await offPage.locator('#shopierCheckoutButton').isDisabled(), true); assert.equal(await offPage.locator('#telegramCheckoutButton').isDisabled(), false);
    results.cases.push({ name: 'disabled', cardCheckoutDisabled: true, existingMethodsPreserved: true }); await off.close();
    process.env.SHOPIER_ENABLED='true';
    for(const [record,row] of app.db.records)if(record.startsWith('storeInventory/')&&row.status==='available')row.status='revoked';inventory.invalidateStockCache();
    const empty=await context({width:390,height:844},undefined,true),emptyPage=await empty.newPage();await emptyPage.goto(app.origin+'/#account/cart',{waitUntil:'domcontentloaded'});await emptyPage.waitForFunction(()=>document.documentElement.dataset.storefrontStatus==='ready');await emptyPage.locator('#customerViewCart').waitFor({state:'visible'});
    assert.equal(await emptyPage.locator('#cartEmpty').isVisible(),true);assert.equal(await emptyPage.locator('#shopierCheckoutButton').isVisible(),true);assert.equal(await emptyPage.locator('#shopierCheckoutButton').isDisabled(),false);
    await emptyPage.locator('#shopierCheckoutButton').click();await emptyPage.locator('#accountTopupForm').waitFor({state:'visible'});
    assert.equal([...app.db.records].filter(([record,row])=>record.startsWith('storeInventory/')&&row.status==='available').length,0);
    results.cases.push({name:'zero-stock-empty-cart',shopierVisibleAndEnabled:true,opensAccountTopup:true});await empty.close();
    assert.deepEqual(errors, []); results.pageErrors = errors; results.passed = results.cases.length; results.failed = 0;
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally { if (browser) await browser.close(); if (provider) provider.close(); if (app) await app.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
