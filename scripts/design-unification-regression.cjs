'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Keep navigation, theme and security contracts from silently diverging.
test('all storefront account pages share one blue ZENTRA shell', () => {
  const accounts = source('public/js/app/account-pages.mjs');
  const destinations = [
    ['/hesabim', 'Hesap Merkezi'], ['/siparisler', 'Siparişlerim'],
    ['/sepet', 'Sepetim'], ['/bildirimler', 'Bildirimlerim'],
    ['/hesabim?bolum=preferences', 'Bildirim Tercihleri'],
    ['/hesabim?bolum=sessions', 'Cihazlarım'],
    ['/hesabim?bolum=support', 'Destek Taleplerim'],
  ];
  for (const [url, label] of destinations) {
    assert.ok(accounts.includes(JSON.stringify(url)), url);
    assert.ok(accounts.includes(JSON.stringify(label)), label);
  }
  assert.match(accounts, /account-workspace__top/);
  assert.match(accounts, /aria-current=/);
  assert.match(accounts, /return uid\(\) \? shell\(content, "cart"\) : content/);
});

test('route stylesheet overrides legacy sheets and uses cache version 110', () => {
  const html = source('store-pages.html');
  assert.match(html, /data-zentra-page="routes"/);
  assert.match(html, /data-zentra-route="home"/);
  assert.match(html, /class="route-desktop-nav"/);
  assert.match(html, /store\.js\?v=110/);
  assert.ok(html.lastIndexOf('zentra-unified.css?v=110') > html.lastIndexOf('product-appearance.css?v=109'));
  const css = source('public/css/zentra-unified.css');
  assert.match(css, /\.account-sidebar/);
  assert.match(css, /\.notification-summary/);
  assert.match(css, /\.help-hero/);
  assert.match(css, /@media \(max-width:820px\)/);
  assert.match(css, /@media \(max-width:600px\)/);
  assert.match(css, /prefers-reduced-motion/);
});

test('private account subpages retain existing service and order APIs', () => {
  const store = source('public/js/app/store.js');
  const pages = source('public/js/app/account-pages.mjs');
  assert.match(store, /commerce\.accountSection\(r\.query\.get\("bolum"\)\)/);
  assert.match(store, /\/api\/store\/orders\?limit=20/);
  assert.match(pages, /checkoutState\(/);
  assert.match(pages, /state\.auth\.account\.balanceKurus/);
  assert.match(store, /commerce\.checkoutQuote\(/);
  assert.match(store, /createCommerceClient/);
});

test('notification destinations are validated before becoming navigation hrefs', () => {
  const store = source('public/js/app/store.js');
  assert.match(store, /safeStorePath\(n\.href \|\| ""\) \|\| "\/bildirimler"/);
  assert.match(store, /href="\$\{e\(href\)\}"/);
  assert.match(store, /\/hesabim\?bolum=preferences/);
  assert.match(store, /data-action="notification-read"/);
});

test('mobile viewport is native scale, no old 0.8 or 0.85 zoom', () => {
  for (const file of [
    'index.html', 'store-pages.html', 'admin/admin.html', 'admin/index.html',
    'admin/session/handoff/index.html', 'offline.html', 'unavailable.html',
    '404.html', 'sifre-yenile.html',
  ]) {
    const html = source(file);
    assert.match(html, /initial-scale=1(?:[\s,\"]|$)/, file);
    assert.doesNotMatch(html, /initial-scale=0\.(?:8|85)/, file);
  }
});

test('application version and service-worker cache keys are aligned', () => {
  const version = JSON.parse(source('package.json')).version;
  const lock = JSON.parse(source('package-lock.json'));
  assert.equal(version, '110.0.0');
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.match(source('sw.js'), /zentra-public-v110/);
  assert.match(source('public/js/app/store.js'), /account-pages\.mjs\?v=110/);
  assert.match(source('public/js/app/store.js'), /commerce-client\.js\?v=110/);
});

test('account and admin both retain their operational entry points', () => {
  const index = source('index.html');
  const admin = source('admin/admin.html');
  assert.match(index, /ZENTRA STORE/i);
  assert.match(admin, /data-admin-panel="orders"/);
  assert.match(admin, /adminLogout/);
  assert.match(admin, /zentra-admin-release" content="110"/);
});

test('safeStorePath rejects unsafe external schemes and accepts internal account destinations', async () => {
  const {safeStorePath} = await import('../public/js/app/routes.mjs');
  for (const bad of [
    'javascript:alert(1)', 'https://example.com/', '//example.com/path',
    '/\\evil', '/%2f%2fevil', '/foo', '/admin/admin.html',
    '/hesabim\n', 'data:text/html,hi',
  ]) assert.equal(safeStorePath(bad), '', `should reject ${bad}`);
  for (const good of ['/hesabim?bolum=sessions','/hesabim?bolum=preferences','/siparisler','/sepet','/bildirimler'])
    assert.equal(safeStorePath(good), good);
});


test('home has accessible premium hero with preserved catalog and account actions', () => {
  const html = source('index.html');
  assert.match(html, /<section class="zentra-home-hero"/);
  assert.match(html, /<h1 id="zentraHomeHeroTitle">/);
  assert.match(html, /data-store-scroll="catalog"/);
  assert.match(html, /data-store-open="orders"/);
  assert.ok(html.indexOf('zentra-home-hero') < html.indexOf('data-showcase-slider'));
  assert.match(html, /zentra-home\.css\?v=110/);
  const css = source('public/css/zentra-home.css');
  assert.match(css, /@media\(max-width:640px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /data-zentra-page="store"/);
});
