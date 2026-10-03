'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const failures = [];
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename);
    else files.push(filename);
  }
}
walk(root);
const relative = (filename) => path.relative(root, filename).split(path.sep).join('/');
let jsCount = 0, referenceCount = 0;
let cssCount = 0;
function cssStructureValid(source) {
  const stack = [];
  let quote = '', comment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (comment) { if (c === '*' && next === '/') { comment = false; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && next === '*') { comment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ('{(['.includes(c)) stack.push(c);
    else if ('})]'.includes(c) && stack.pop() !== ({ '}': '{', ')': '(', ']': '[' })[c]) return false;
  }
  return !quote && !comment && stack.length === 0;
}
const viewport = '<meta name="viewport" content="width=device-width, initial-scale=0.85, minimum-scale=0.85, maximum-scale=0.85, user-scalable=no, viewport-fit=cover" />';
for (const filename of files) {
  if (!/\.(?:js|cjs|html|css|json)$/.test(filename)) continue;
  const source = fs.readFileSync(filename, 'utf8');
  const name = relative(filename);
  if (name.endsWith('.css')) {
    cssCount++;
    if (!cssStructureValid(source)) failures.push(name + ': CSS blok, parantez veya metin yapısı bozuk');
  }
  if (/\.(?:js|cjs)$/.test(name)) {
    const esm = name === 'script.js' || name.startsWith('public/js/') || name.startsWith('admin/');
    const result = spawnSync(process.execPath, esm ? ['--input-type=module', '--check'] : ['--check', filename], { input: esm ? source : undefined, encoding: 'utf8' });
    if (result.status !== 0) failures.push(name + ': ' + result.stderr);
    jsCount++;
    const imports = /(?:from\s*|import\s*\(|require\s*\()\s*['"](\.[^'"]+)['"]/g;
    for (const match of source.matchAll(imports)) {
      const target = path.resolve(path.dirname(filename), match[1].split('?')[0]);
      if (![target, target + '.js', target + '.json', path.join(target, 'index.js')].some((item) => fs.existsSync(item))) failures.push(name + ': eksik import ' + match[1]);
    }
  }
  if (name.endsWith('.html')) {
    const metas = [...source.matchAll(/<meta\b[^>]*\bname=["']viewport["'][^>]*>/gi)].map((x) => x[0]);
    if (metas.length !== 1 || metas[0] !== viewport) failures.push(name + ': viewport değişti veya çoğaltıldı');
    const ids = [...source.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
    if (ids.length !== new Set(ids).size) failures.push(name + ': tekrarlanan HTML kimliği');
    for (const match of source.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      const ref = match[1].split(/[?#]/)[0];
      if (/^(?:https?:|data:|mailto:|tel:|\/\/)/.test(ref) || !/\.(?:js|css|svg|png|jpeg|jpg|webp|ico|wav)$/.test(ref)) continue;
      const target = ref.startsWith('/') ? path.join(root, ref) : path.resolve(path.dirname(filename), ref);
      referenceCount++;
      if (!fs.existsSync(target)) failures.push(name + ': eksik dosya ' + ref);
    }
  }
  if (name.endsWith('.json')) {
    try { JSON.parse(source); } catch (_) { failures.push(name + ': geçersiz JSON'); }
  }
  if (name !== 'scripts/verify-source.cjs' && !name.endsWith('package-lock.json')) {
    for (const match of source.matchAll(/["'](\/public\/assets\/[A-Za-z0-9_./-]+\.(?:png|svg|jpg|jpeg|webp|ico|wav))["']/g)) {
      referenceCount++;
      if (!fs.existsSync(path.join(root, match[1]))) failures.push(name + ': eksik asset ' + match[1]);
    }
  }
}
if (!fs.readFileSync(path.join(root, 'server.js'), 'utf8').includes(viewport)) failures.push('Dinamik yönetici sayfasının viewport değeri değişti');
const domGroups = [
  ['index.html', ['script.js', 'public/js/store/storefront.js', 'public/js/store/customer-app.js', 'public/js/store/customer-renderers.js', 'public/js/store/product-gallery.js', 'public/js/store/showcase-slider.js']],
  ['admin/admin.html', ['admin/admin-dashboard.js']],
  ['admin/index.html', ['admin/admin-gate.js']]
];
let literalDomReferences = 0;
for (const [htmlName, scriptNames] of domGroups) {
  const htmlSource = fs.readFileSync(path.join(root, htmlName), 'utf8');
  const elementIds = new Set([...htmlSource.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referencedIds = new Set();
  for (const scriptName of scriptNames) {
    const scriptSource = fs.readFileSync(path.join(root, scriptName), 'utf8');
    for (const match of scriptSource.matchAll(/(?:\$|querySelector)\(\s*['"]#([A-Za-z][\w:-]*)['"]\s*\)/g)) referencedIds.add(match[1]);
    for (const match of scriptSource.matchAll(/getElementById\(\s*['"]([A-Za-z][\w:-]*)['"]\s*\)/g)) referencedIds.add(match[1]);
  }
  literalDomReferences += referencedIds.size;
  for (const id of referencedIds) if (!elementIds.has(id)) failures.push(`${htmlName}: bulunamayan DOM kimliği #${id}`);
}
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public/data/store-products.json')));
const productIds = new Set();
for (const product of catalog.products) {
  if (productIds.has(product.id)) failures.push('Tekrarlanan ürün ' + product.id);
  productIds.add(product.id);
  const planKeys = new Set();
  for (const plan of product.plans || []) {
    if (planKeys.has(plan.key) || !Number.isSafeInteger(plan.priceKurus) || plan.priceKurus < 1) failures.push('Geçersiz paket ' + product.id + ':' + plan.key);
    planKeys.add(plan.key);
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version || JSON.stringify(pkg.dependencies) !== JSON.stringify(lock.packages[''].dependencies) || JSON.stringify(pkg.engines) !== JSON.stringify(lock.packages[''].engines)) failures.push('Paket ve kilit dosyası uyumsuz');
const { CHANNEL_LINKS_REVISION, DEFAULT_QUICK_LINKS } = require(path.join(root, 'server/core/storeLinks.js'));
const expectedChannelUrls = [
  'https://t.me/shelbystoreofficial',
  'https://t.me/+1CNyDrYyBzcwMGY0',
  'https://t.me/shelbystorefree',
  'https://www.tiktok.com/@srfxkayra',
  'https://wa.me/905339673730',
  'https://t.me/shelbyios'
];
if (CHANNEL_LINKS_REVISION !== 69 || JSON.stringify(DEFAULT_QUICK_LINKS.map((link) => link.url)) !== JSON.stringify(expectedChannelUrls)) failures.push('Resmî bağlantı paketi veya geçiş sürümü beklenen değerle uyuşmuyor');
const homeSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if ((homeSource.match(/data-quick-link-id=/g) || []).length !== expectedChannelUrls.length || expectedChannelUrls.some((url) => !homeSource.includes(`href="${url}"`))) failures.push('Ana sayfa bağlantı kartları sunucu bağlantı paketiyle uyuşmuyor');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ syntaxFiles: jsCount, cssStructureFiles: cssCount, htmlPages: files.filter((f) => f.endsWith('.html')).length, localReferences: referenceCount, literalDomReferences, products: productIds.size, officialLinks: expectedChannelUrls.length, viewport: '0.85 / 0.85 / 0.85 unchanged', result: 'PASS' }));
