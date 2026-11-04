'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const { shopierFixture } = require('./helpers/shopier-fixture.cjs');
const firebaseSdk = require('./helpers/browser-firebase.cjs');
const output = path.resolve(process.env.MODERNIZATION_BROWSER_OUTPUT || 'test-results/modernization');
async function main() {
  fs.mkdirSync(output, { recursive: true });
  let app, browser, provider, maintenance, providerJobs; const contexts = [], pages = [], errors = [], assetFailures = [], cases = [];
  try {
    app = await applicationFixture({ shopier: true, transientStore: 'memory', rateLimitStore: 'memory', appCheckMode: 'monitor' });
    provider = shopierFixture(); maintenance = require('../server/core/orderMaintenanceService'); maintenance.startMaintenanceWorker();
    providerJobs = require('../server/core/shopierJobs'); providerJobs.startShopierWorker();
    const store = require('../server/core/storeService'), catalog = await require('../server/core/storeCatalogService').getEffectiveCatalog();
    const product = catalog.products.find(row => row.telegramEnabled), plan = product.plans[0];
    const orders = [];
    for (let index = 0; index < 3; index++) orders.push((await store.createOrder({ uid: 'member', authUser: app.users.get('member'), paymentMethod: 'telegram',
      rawItems: [{ productId: product.id, planKey: plan.key, quantity: 1 }], idempotencyKey: crypto.randomUUID() })).order);
    const shopier = await require('../server/core/shopierService').createShopierPayment({ uid: 'member', authUser: app.users.get('member'), purpose: 'wallet_topup', amountKurus: 10000, idempotencyKey: crypto.randomUUID() });
    app.db.records.set('audit/expired-operational', { type: 'store-content-update', at: Date.now() - 100 * 86400_000, actor: { uid: 'owneruid', email: 'owner@zentra.invalid' }, reason: 'Süresi bitmiş test operasyon kaydı' });
    app.db.records.set('audit/long-operation', { type: 'store-order-update', at: Date.now(), previousStatus: 'awaiting_payment', status: 'cancelled', actor: { uid: 'owneruid', email: 'owner@zentra.invalid' }, requestId: 'operation-' + 'x'.repeat(140), reason: 'Uzun denetim açıklaması '.repeat(20) });
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : { channel: 'chrome' }),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], env: { ...process.env, ...(process.env.CHROMIUM_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.CHROMIUM_LIBRARY_PATH } : {}) } });
    async function context(uid, android = false) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        userAgent: android ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', reducedMotion: 'reduce' });
      contexts.push(ctx);
      await ctx.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: firebaseSdk }));
      await ctx.route('https://encrypted-tbn0.gstatic.com/images**', route => route.fulfill({ contentType: 'image/webp', body: fs.readFileSync(path.resolve(__dirname, '../public/assets/images/zentra-mark.webp')) }));
      await ctx.addInitScript(value => { globalThis.__qaIdentity = value.identity; globalThis.__qaPassword = value.password; }, { identity: { uid, email: app.users.get(uid).email, token: app.idToken(uid) }, password: app.password });
      const page = await ctx.newPage(); page.setDefaultTimeout(20000); pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.status() >= 400 && /\.(?:m?js|css|woff2?|png|jpe?g|webp)(?:\?|$)/.test(response.url())) assetFailures.push({ path: new URL(response.url()).pathname, status: response.status() }); });
      return page;
    }
    async function gate(page) {
      await page.goto(app.origin + '/admin/index.html', { waitUntil: 'domcontentloaded' });
      await page.locator('#firebasePassword').fill(app.password); await page.locator('#firebasePasswordForm button[type=submit]').click();
      await page.locator('#fourthFactor').fill(app.four); await page.locator('#fourthFactorForm button[type=submit]').click();
      await page.locator('#fifthFactor').fill(app.five); await page.locator('#fifthFactorForm button[type=submit]').click();
      await page.locator('#adminTotpCode').fill(app.totp()); await page.locator('#sixthFactorForm button[type=submit]').click();
      await page.locator('#adminLoader.is-hidden').waitFor({ state: 'attached' });
    }
    async function panel(page, name) { await page.locator(`[data-panel="${name}"]`).first().click(); await page.locator(`[data-admin-panel="${name}"]`).waitFor({ state: 'visible' }); }
    async function authorize(page) { await page.locator('#reauthLayer').waitFor({ state: 'visible' }); await page.locator('#reauthPassword').fill(app.password); await page.locator('#reauthForm button[type=submit]').click(); }
    async function saveDialog(page, suffix = '/api/admin/store/links') {
      const response = page.waitForResponse(row => new URL(row.url()).pathname.endsWith(suffix) && ['PUT', 'PATCH', 'POST'].includes(row.request().method()));
      await page.locator('dialog[open] button[type=submit]').click(); await authorize(page);
      const result = await response; assert.equal(result.status(), 200, await result.text());
      await page.locator('dialog[open]').waitFor({ state: 'detached' });
      await page.waitForFunction(() => [...document.querySelectorAll('#adminQuickLinks button')].some(button => !button.disabled));
      return result;
    }
    const page = await context('owneruid'); await gate(page); await panel(page, 'links'); await page.locator('.managed-link').first().waitFor();
    assert.equal(await page.locator('.managed-link').count(), 7);
    await page.locator('[data-managed-link="tiktok-official"] [data-link-action="edit"]').click();
    const form = page.locator('dialog[open]');
    await form.locator('[name=title]').fill('ZENTRA Canlı Yayın'); await form.locator('[name=description]').fill('Güncel yayınlarımızı takip edin');
    await form.locator('[name=url]').fill('https://www.tiktok.com/@zentrastorelive'); await form.locator('[name=position]').fill('1');
    await form.locator('[name=showOnHome]').uncheck(); await saveDialog(page);
    let saved = app.db.records.get('storefrontSettings/main').quickLinks;
    assert.equal(saved[0].id, 'tiktok-official'); assert.equal(saved[0].showOnHome, false); assert.equal(saved[0].title, 'ZENTRA Canlı Yayın');
    const home = await page.context().newPage(); pages.push(home); await home.goto(app.origin); await home.waitForFunction(() => document.querySelectorAll('[data-quick-link-id]').length === 6);
    assert.equal(await home.locator('[data-quick-link-id="tiktok-official"]').count(), 0);
    await page.locator('[data-managed-link="tiktok-official"] [data-link-action="edit"]').click(); await page.locator('dialog[open] [name=showOnHome]').check(); await saveDialog(page);
    await home.reload(); await home.locator('[data-quick-link-id="tiktok-official"]').waitFor();
    assert.equal(await home.locator('[data-quick-link-id="tiktok-official"] strong').textContent(), 'ZENTRA Canlı Yayın'); await home.close();
    cases.push({ name: 'link-edit-reorder-and-home-publication', persisted: true, authoritativeReload: true, independentVisibility: true });
    await page.locator('#addQuickLink').click();
    await page.locator('dialog[open] [name=title]').fill('Yeni Kanal'); await page.locator('dialog[open] [name=description]').fill('Resmî yeni kanal');
    await page.locator('dialog[open] [name=url]').fill('https://evil.invalid/unsafe'); await page.locator('dialog[open] button[type=submit]').click();
    await page.locator('dialog[open] [role=alert]:visible').waitFor(); assert.equal(app.db.records.get('storefrontSettings/main').quickLinks.length, 7);
    await page.locator('dialog[open] [name=url]').fill('https://t.me/zentra_newchannel'); await saveDialog(page);
    assert.equal(app.db.records.get('storefrontSettings/main').quickLinks.length, 8);
    const added = page.locator('.managed-link').filter({ has: page.locator('h3', { hasText: 'Yeni Kanal' }) });
    await added.locator('[data-link-action=toggle]').click(); await authorize(page);
    await page.waitForFunction(() => document.querySelector('[data-managed-link]') && [...document.querySelectorAll('.managed-link')].some(row => row.textContent.includes('Yeni Kanal') && row.querySelector('.managed-link__state')?.textContent === 'Pasif'));
    assert.equal(app.db.records.get('storefrontSettings/main').quickLinks.find(row => row.title === 'Yeni Kanal').enabled, false);
    await added.locator('[data-link-action=delete]').click(); await saveDialog(page);
    assert.equal(app.db.records.get('storefrontSettings/main').quickLinks.length, 7);
    cases.push({ name: 'link-create-toggle-delete-and-malicious-url', realWrites: true, invalidUrlBlocked: true });
    await panel(page, 'orders'); await page.locator(`[data-admin-order="${orders[0].id}"]`).waitFor();
    const orderCard = page.locator(`[data-admin-order="${orders[0].id}"]`);
    await orderCard.locator('[data-order-status-open]').click();
    assert.equal(await page.locator('dialog[open] [name=status]:checked').inputValue(), 'awaiting_payment');
    for (let index = 0; index < 8; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement)), true); }
    await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-order-status-open')), true);
    await orderCard.locator('[data-order-status-open]').click(); await page.locator('dialog[open] [name=status][value=payment_review]').check();
    const reviewResponse = page.waitForResponse(row => row.request().method() === 'PATCH' && row.url().includes('/api/admin/store/orders/' + orders[0].id));
    await page.locator('dialog[open] button[type=submit]').click(); await authorize(page); assert.equal((await reviewResponse).status(), 200);
    await page.waitForFunction(id => document.querySelector(`[data-admin-order="${id}"] [data-order-status]`)?.value === 'payment_review', orders[0].id);
    assert.equal(app.db.records.get('storeOrders/' + orders[0].id).status, 'payment_review');
    await orderCard.locator('[data-order-status-open]').click(); await page.locator('dialog[open] [name=status][value=paid]').check(); await page.locator('dialog[open] button[type=submit]').click();
    const paymentResponse = page.waitForResponse(row => row.request().method() === 'PATCH' && row.url().includes('/api/admin/store/orders/' + orders[0].id));
    await page.locator('dialog[open] [name=reference]').fill('BANK-VERIFIED-UI-001'); await page.locator('dialog[open] [name=confirmed]').check(); await page.locator('dialog[open] button[type=submit]').click(); await authorize(page);
    await page.waitForFunction(id => document.querySelector(`[data-admin-order="${id}"] [data-order-status]`)?.value === 'paid', orders[0].id);
    assert.equal((await paymentResponse).status(), 200);
    assert.equal(app.db.records.get('storeOrders/' + orders[0].id).manualPayment.reference, 'BANK-VERIFIED-UI-001');
    cases.push({ name: 'status-dialog-keyboard-focus-and-payment-evidence', focusContained: true, escapeRestoresFocus: true, backendPersisted: true });
    const closeResponse = page.waitForResponse(row => row.request().method() === 'POST' && row.url().includes('/shopier/close'));
    await page.locator(`[data-admin-order="${shopier.order.id}"] [data-shopier-action=close]`).click(); await authorize(page);
    await page.locator(`[data-admin-order="${shopier.order.id}"] [data-shopier-action=close]:disabled`).waitFor();
    assert.equal((await closeResponse).status(), 202);
    await page.waitForFunction(id => document.querySelector(`[data-admin-order="${id}"] [data-shopier-action=close]`)?.textContent.includes('kapatıldı'), shopier.order.id);
    assert.equal(app.db.records.get('storeOrders/' + shopier.order.id).paymentState, 'link_closed');
    assert.equal(provider.products.get(shopier.order.shopier.productId).stockQuantity, 0); cases.push({ name: 'provider-verified-link-close', closedButtonDisabled: true, providerStockVerified: true });
    await page.locator('[data-bulk-operation=cancel_telegram]').click(); await page.locator('dialog[open]').waitFor();
    assert.match(await page.locator('dialog[open]').textContent(), /Toplam hedeflenen kayıt/);
    await page.locator('dialog[open] button[type=submit]').click(); await authorize(page);
    await page.waitForResponse(row => row.request().method() === 'POST' && /\/maintenance\/[^/]+\/orders\/confirm/.test(row.url()) && row.status() === 202);
    await page.reload(); await page.locator('#adminLoader.is-hidden').waitFor({ state: 'attached' }); await panel(page, 'orders');
    await page.locator('#orderMaintenance h3', { hasText: 'İşlem sonuçlandı' }).waitFor();
    assert.equal(app.db.records.get('storeOrders/' + orders[0].id).status, 'paid');
    assert.equal(app.db.records.get('storeOrders/' + orders[1].id).status, 'cancelled');
    assert.equal(app.db.records.get('storeOrders/' + orders[2].id).status, 'cancelled');
    cases.push({ name: 'bulk-preview-confirm-progress-and-reload-recovery', paidExternalOrderExcluded: true, resumable: true });
    const extraOrder = (await store.createOrder({ uid: 'member', authUser: app.users.get('member'), paymentMethod: 'telegram',
      rawItems: [{ productId: product.id, planKey: plan.key, quantity: 1 }], idempotencyKey: crypto.randomUUID() })).order;
    await page.locator('[data-refresh=orders]').click(); await page.locator(`[data-admin-order="${extraOrder.id}"]`).waitFor();
    await page.locator('[data-bulk-operation=cancel_all]').click(); await page.locator('dialog[open]').waitFor();
    const mixedConfirmation = page.waitForResponse(row => row.request().method() === 'POST' && /\/maintenance\/[^/]+\/orders\/confirm/.test(row.url()) && row.status() === 202);
    await page.locator('dialog[open] button[type=submit]').click(); await authorize(page);
    const mixed = (await (await mixedConfirmation).json()).job;
    await page.waitForFunction(id => document.querySelector(`[data-admin-order="${id}"] .order-state`)?.textContent.includes('İPTAL EDİLDİ'), extraOrder.id);
    assert.notEqual(app.db.records.get('storeMaintenanceJobs/' + mixed.id).state, 'completed');
    await page.locator('#orderMaintenance summary').click(); await page.locator('#orderMaintenance [data-refresh-results]').click();
    assert.match(await page.locator('#orderMaintenance .maintenance-results').textContent(), /İptal edildi/);
    const closedRow = app.db.records.get('storeOrders/' + shopier.order.id);
    closedRow.shopier.linkClosedAt = Date.now() - 11 * 60_000; closedRow.shopier.closeReviewAfter = 0;
    for (const [key, item] of app.db.records) if (key.startsWith('storeMaintenanceJobs/' + mixed.id + '/items/') && item.state === 'waiting') item.availableAt = 0;
    app.db.records.get('storeMaintenanceJobs/' + mixed.id).availableAt = 0; maintenance.wakeMaintenanceWorker();
    await page.locator('#orderMaintenance h3', { hasText: 'İşlem sonuçlandı' }).waitFor();
    assert.equal(app.db.records.get('storeOrders/' + shopier.order.id).status, 'cancelled');
    cases.push({ name: 'mixed-bulk-shows-real-partial-telegram-results-before-shopier-finalization', partialResultVisible: true, eventualProviderVerifiedCancellation: true });
    const refundable = await require('../server/core/shopierService').createShopierPayment({ uid: 'member', authUser: app.users.get('member'), purpose: 'wallet_topup', amountKurus: 10000, idempotencyKey: crypto.randomUUID() });
    provider.paid(refundable.order.shopier.productId);
    const walletBefore = app.db.records.get('users/member').storeBalanceKurus;
    await page.locator('[data-refresh=orders]').click(); await page.locator(`[data-admin-order="${refundable.order.id}"]`).waitFor();
    await page.locator(`[data-admin-order="${refundable.order.id}"] [data-shopier-action=cancel]`).click();
    await page.locator('dialog[open] button[type=submit]').click();
    const cancelResponse = page.waitForResponse(row => row.request().method() === 'POST' && row.url().includes(`/orders/${refundable.order.id}/shopier/cancel`));
    await authorize(page); assert.equal((await cancelResponse).status(), 202);
    for (let attempt = 0; attempt < 100 && !app.db.records.get('storeOrders/' + refundable.order.id).shopier.refundRequest?.providerRefundId; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    const refundId = app.db.records.get('storeOrders/' + refundable.order.id).shopier.refundRequest?.providerRefundId;
    assert.ok(refundId); assert.equal(app.db.records.get('users/member').storeBalanceKurus, walletBefore);
    provider.completeRefund(refundId); app.db.records.get('shopierJobs/cancel_' + refundable.order.id).availableAt = 0; providerJobs.wakeShopierWorker();
    await page.waitForFunction(id => document.querySelector(`[data-admin-order="${id}"] .order-state`)?.textContent.includes('İade Tamamlandı'), refundable.order.id);
    assert.equal(provider.calls.filter(call => call.method === 'POST' && call.path === '/refunds' && call.body.orderId === provider.refunds.get(refundId).orderId).length, 1);
    cases.push({ name: 'single-cancel-dialog-durable-refund-and-no-intermediate-wallet-credit', actualProofAndQueue: true, noDuplicateRefund: true });
    await panel(page, 'audit'); await page.locator('.audit-record').first().waitFor();
    await page.locator('#auditSearch').fill('long-operation'); assert.equal(await page.locator('.audit-record').count(), 1); await page.locator('#auditSearch').fill('');
    await page.locator('[data-bulk-operation=delete_audit]').click(); await page.locator('dialog[open]').waitFor();
    await page.locator('dialog[open] button[type=submit]').click(); assert.equal(await page.locator('dialog[open]').count(), 1);
    await page.locator('dialog[open] [name=confirmation]').fill('KALICI SIL'); await page.locator('dialog[open] button[type=submit]').click(); await authorize(page);
    await page.locator('#auditMaintenance h3', { hasText: 'İşlem sonuçlandı' }).waitFor();
    assert(!app.db.records.has('audit/expired-operational')); assert(app.db.records.has('audit/long-operation'));
    cases.push({ name: 'audit-cards-search-and-retention-aware-purge', typedSecondConfirmation: true, protectedFinancialRecordPreserved: true });
    await panel(page, 'security'); await page.locator('#securityChecks .security-check').first().waitFor();
    assert.equal(await page.locator('#securityChecks .security-check').count(), 20); assert.match(await page.locator('#securityEvidence').textContent(), /Doğrulanmamış/);
    assert(Number(await page.locator('#securityScore').textContent()) < 98); cases.push({ name: 'evidence-based-security', noInventedHighScore: true, unknownControlsVisible: true });
    assert(!/KORUMA HAZIR/.test(await page.locator('#securityRuntime').textContent()));
    assert.match(await page.locator('#securityChecks').textContent(), /Gerekli işlem:/);
    const securityColor = await page.locator('#securityLevel').evaluate(node => getComputedStyle(node).color);
    assert(['rgb(255, 116, 133)', 'rgb(231, 183, 101)'].includes(securityColor));
    assert.equal(await page.locator('#securityRing').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    cases.push({ name: 'security-warning-colors-and-remediation-match-failed-controls', noFalseReadyBanner: true, noStaticGreenCriticalState: true });
    for (const width of [320, 360, 390, 430, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      for (const name of ['links', 'orders', 'audit', 'security']) {
        await panel(page, name);
        const layout = await page.evaluate(name => {
          const panel = document.querySelector(`[data-admin-panel="${name}"]`);
          const elements = [...panel.querySelectorAll('.managed-link,.audit-record,.bulk-actions button,.admin-order,.security-check')];
          return { viewport: innerWidth, width: document.documentElement.scrollWidth, meta: document.querySelector('meta[name=viewport]').content,
            overflow: elements.map(node => ({ name: node.className, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })).filter(row => row.left < -1 || row.right > innerWidth + 1) };
        }, name);
        assert(layout.width <= layout.viewport + 1, JSON.stringify(layout)); assert.deepEqual(layout.overflow, [], JSON.stringify(layout)); assert.match(layout.meta, /initial-scale=0.8, minimum-scale=0.8, maximum-scale=0.8/);
        cases.push({ name: `${name}-responsive-${width}`, layout });
        if (width === 390) await page.screenshot({ path: path.join(output, name + '-mobile.png'), fullPage: false });
      }
    }
    app.db.records.set('adminUsers/member', { role: 'admin', email: 'member@zentra.invalid', active: true, policyVersion: 1 });
    const android = await context('member', true); await gate(android); await panel(android, 'links');
    await android.locator('.managed-link').first().waitFor(); await android.locator('.managed-link [data-link-action=edit]').first().click();
    const modalLayout = await android.locator('dialog[open]').evaluate(node => ({ viewport: innerWidth, width: node.getBoundingClientRect().width, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, height: node.getBoundingClientRect().height, viewportHeight: innerHeight }));
    assert(modalLayout.left >= 0 && modalLayout.right <= modalLayout.viewport + 1); assert(modalLayout.height <= modalLayout.viewportHeight);
    await android.screenshot({ path: path.join(output, 'android-link-modal.png'), fullPage: false });
    cases.push({ name: 'android-user-agent-and-touch-modal', layout: modalLayout, engine: 'Chromium emulation; physical Safari/Android testing not claimed' });
    assert.deepEqual(errors, []); assert.deepEqual(assetFailures, []);
    const result = { passed: cases.length, failed: 0, livePayments: 0, liveRefunds: 0, pageErrors: errors, assetFailures, cases };
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ pageErrors: errors, assetFailures }));
    for (let index = 0; index < pages.length; index++) if (!pages[index].isClosed()) await pages[index].screenshot({ path: path.join(output, `failure-${index}.png`), fullPage: false }).catch(() => {});
    throw error;
  } finally {
    maintenance?.stopMaintenanceWorker(); providerJobs?.stopShopierWorker(); for (const ctx of contexts) await ctx.close().catch(() => {});
    if (browser) await browser.close(); provider?.close(); if (app) await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
