"use strict";
// Development-only preview. Production always starts server.js directly.
process.env.NODE_ENV = "development";
const index = process.argv.indexOf("--port");
process.env.PORT =
  index >= 0 ? process.argv[index + 1] : process.env.PORT || "4173";
process.env.PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT}`;
process.env.PUBLIC_BACKEND_ORIGIN = process.env.PUBLIC_BASE_URL;
process.env.PUBLIC_API_BASE = process.env.PUBLIC_BASE_URL;
process.env.CANONICAL_ORIGIN = process.env.PUBLIC_BASE_URL;
const { configureHttpServer } = require("../server/core/requestSecurity");
const { safeStorePath } = require("../public/js/app/routes.mjs");
function requestWrapper(req, res, app) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/__supplier-layout") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    return res.end(`<!doctype html><html lang="tr" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=0.85, minimum-scale=0.85, maximum-scale=0.85, viewport-fit=cover" /><title>Hilehanem · Salt okunur görünüm kontrolü</title><link rel="stylesheet" href="/public/assets/fonts/fonts.css"><link rel="stylesheet" href="/public/css/zentra.css?v=108"><link rel="stylesheet" href="/admin/zentra-admin.css?v=108"><link rel="stylesheet" href="/public/css/device.css?v=108"></head><body class="admin-page"><div id="preview-root"></div><script type="module">import {adminLayout} from '/admin/layout.mjs?v=108';import {supplierView} from '/admin/supplier-view.mjs?v=108';const root=document.querySelector('#preview-root');root.innerHTML=adminLayout({email:'gorunum@zentra.invalid',role:'Görünüm kontrolü',permissions:['*']});const fixture={mode:'native_api',configured:false,active:false,state:'configuration_required',balanceUsdCents:null,automaticPurchasing:false,missing:['HILEHANEM_API_BASE_URL','HILEHANEM_API_KEY']};root.querySelector('main').innerHTML='<p class="notice" role="status">Görünüm kontrolü · Tamamen örnek veriler · Üretim hesabına bağlı değildir</p>'+supplierView(fixture);root.querySelectorAll('button').forEach(button=>button.disabled=true);</script></body></html>`);
  }
  if (url.pathname === "/__email-verification") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    });
    return res.end(
      `<!doctype html><html lang="tr" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=0.85, minimum-scale=0.85, maximum-scale=0.85, viewport-fit=cover" /><title>E-posta doğrulama ekranı · Görünüm kontrolü</title><link rel="stylesheet" href="/public/assets/fonts/fonts.css"><link rel="stylesheet" href="/public/css/zentra.css?v=108"><link rel="stylesheet" href="/public/css/device.css?v=108"><link rel="stylesheet" href="/public/css/verification.css?v=108"></head><body><header class="container" style="padding:20px"><a class="brand" href="/"><img class="brand-image" src="/public/assets/images/apple-touch-icon.png" width="64" height="64" alt="Zentra Store"><span class="brand-text">ZENTRA STORE</span></a><p role="status">Görünüm kontrolü · Örnek veri · İşlem düğmeleri devre dışı</p></header><main id="main" class="container"></main><script type="module">import {verificationMarkup,mountVerificationClock} from '/public/js/app/verification.mjs?v=108';const now=Date.now(),value={challengeId:'preview',email:'o***@zentra.invalid',delivery:'accepted',state:'pending',remainingAttempts:5,expiresAt:now+300000,resendAt:now+60000,serverNow:now};document.querySelector('main').innerHTML=verificationMarkup(value);document.querySelectorAll('button,input').forEach(node=>{node.disabled=true;node.setAttribute('aria-busy','true')});mountVerificationClock(document,value);</script></body></html>`,
    );
  }
  if (url.pathname === "/__admin-layout") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    });
    return res.end(
      `<!doctype html><html lang="tr" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=0.85, minimum-scale=0.85, maximum-scale=0.85, viewport-fit=cover" /><title>Admin · Salt okunur görünüm kontrolü</title><link rel="stylesheet" href="/public/assets/fonts/fonts.css"><link rel="stylesheet" href="/public/css/zentra.css?v=108"><link rel="stylesheet" href="/admin/zentra-admin.css?v=108"></head><body class="admin-page"><div id="preview-root"></div><script type="module">import {adminLayout} from '/admin/layout.mjs?v=108';import {inventoryView} from '/admin/inventory-view.mjs?v=108';const ctx={email:'gorunum@zentra.invalid',role:'Görünüm kontrolü',permissions:['*']};const root=document.querySelector('#preview-root');root.innerHTML=adminLayout(ctx);const main=root.querySelector('main');main.innerHTML='<p class="notice" role="status">Salt okunur tasarım kontrolü. Örnek veriler; gerçek yönetici oturumu veya üretim işlemi değildir.</p><header class="admin-view-header"><div><span class="eyebrow">STOK KASASI</span><h1>Stok yönetimi.</h1><p>Eski panel düzeni, yeni Zentra tasarım sistemi.</p></div></header>';const r=await fetch('/api/store/catalog').then(r=>r.json());main.insertAdjacentHTML('beforeend',inventoryView(r.catalog.products.slice(0,4).flatMap(p=>p.plans.slice(0,1).map(plan=>({productId:p.id,productName:p.name,planKey:plan.key,planLabel:plan.label,available:0,delivered:0}))),r.catalog,true));root.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=true);</script></body></html>`,
    );
  }
  if (url.pathname === "/__admin-products-preview.mjs") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(require("node:fs").readFileSync(require("node:path").join(__dirname, "helpers/admin-products-preview.mjs")));
  }
  if (url.pathname === "/__admin-products") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    return res.end(`<!doctype html><html lang="tr" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=0.85, minimum-scale=0.85, maximum-scale=0.85, viewport-fit=cover" /><title>Ürün yönetimi · Salt okunur görünüm kontrolü</title><link rel="stylesheet" href="/public/assets/fonts/fonts.css"><link rel="stylesheet" href="/public/css/zentra.css?v=108"><link rel="stylesheet" href="/admin/zentra-admin.css?v=108"><link rel="stylesheet" href="/public/css/device.css?v=108"></head><body class="admin-page"><div id="preview-root"></div><script type="module" src="/__admin-products-preview.mjs"></script></body></html>`);
  }
  if (url.pathname === "/__customer-preview.mjs") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(require("node:fs").readFileSync(require("node:path").join(__dirname, "helpers/customer-preview.mjs")));
  }
  if (url.pathname === "/__customer-layout") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    return res.end(`<!doctype html><html lang="tr" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=0.85, minimum-scale=0.85, maximum-scale=0.85, viewport-fit=cover" /><title>Hesap arayüzü · Salt okunur görünüm kontrolü</title><link rel="stylesheet" href="/public/assets/fonts/fonts.css"><link rel="stylesheet" href="/public/css/zentra.css?v=108"><link rel="stylesheet" href="/public/css/commerce.css?v=108"><link rel="stylesheet" href="/public/css/storefront.css?v=108"><link rel="stylesheet" href="/public/css/device.css?v=108"></head><body><main id="main" class="container main-content"></main><script type="module" src="/__customer-preview.mjs"></script></body></html>`);
  }
  if (url.pathname === "/__viewport") {
    const width = Math.min(
      1440,
      Math.max(320, Number(url.searchParams.get("width")) || 375),
    );
    const route = String(url.searchParams.get("page") || "/");
    const target = (
      safeStorePath(route) ||
      ([
        "/admin/",
        "/404.html",
        "/offline.html",
        "/unavailable.html",
        "/__email-verification",
        "/__admin-layout",
        "/__admin-products",
        "/__customer-layout",
        "/__supplier-layout",
      ].includes(route.split("?")[0])
        ? route
        : "/")
    )
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    });
    return res.end(
      `<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width, initial-scale=0.85, minimum-scale=0.85, maximum-scale=0.85, viewport-fit=cover" /><title>Responsive preview</title><style>body{background:#e9ecf2;font:14px system-ui;margin:0}header{text-align:center;padding:14px}header button{margin:0 5px;padding:5px 8px;border:1px solid #8995a5;background:white;border-radius:5px;color:#24394b;cursor:pointer}iframe{display:block;margin:auto;width:${width}px;height:850px;border:1px solid #ccd1dc;background:#04121b;box-shadow:0 10px 35px #2235}</style></head><body><header><span id="preview-width">Test genişliği: ${width}px</span> · ${[320, 375, 390, 414, 768, 1024, 1280].map((w) => '<button type="button" data-width="' + w + '">' + w + "</button>").join("")} · <button type="button" data-preview-scale="100">Metin %100</button><button type="button" data-preview-scale="200">Metin %200</button></header><iframe title="Zentra Store responsive preview" src="${target}"></iframe><script>document.querySelector('header').addEventListener('click',event=>{const scaleButton=event.target.closest('[data-preview-scale]');if(scaleButton){const root=document.querySelector('iframe').contentDocument.documentElement;root.dataset.textScale=scaleButton.dataset.previewScale;root.style.setProperty('--reading-scale',Number(scaleButton.dataset.previewScale)/100);return;}const button=event.target.closest('[data-width]');if(!button)return;const width=Number(button.dataset.width);document.querySelector('iframe').style.width=width+'px';document.querySelector('#preview-width').textContent='Test genişliği: '+width+'px';});</script></body></html>`,
    );
  }
  const setHeader = res.setHeader;
  res.setHeader = function (name, value) {
    if (String(name).toLowerCase() === "cache-control") value = "no-store";
    if (String(name).toLowerCase() === "content-security-policy")
      value = String(value).replace(
        "frame-ancestors 'none'",
        "frame-ancestors 'self'",
      );
    if (String(name).toLowerCase() === "x-frame-options") value = "SAMEORIGIN";
    return setHeader.call(this, name, value);
  };
  app(req, res);
}
async function start() {
  if (process.argv.includes("--fixture")) {
    const fixture =
      await require("./helpers/application-fixture.cjs").applicationFixture({
        port: Number(process.env.PORT),
        host: "0.0.0.0",
        appCheckMode: "off",
        rateLimitStore: "memory",
        transientStore: "memory",
        requestWrapper,
      });
    const products = (await fixture.request("/api/store/catalog")).body.catalog
      .products;
    const product = products[0];
    fixture.db.records.set("storeReviews/development-review", {
      productId: product.id,
      uid: "member",
      orderId: "development-order",
      status: "published",
      verifiedPurchase: true,
      displayName: "Görünüm kontrolü",
      rating: 5,
      title: "Örnek değerlendirme",
      message:
        "Bu içerik yalnızca yerel görünüm testinde kullanılır; canlı müşteri değerlendirmesi değildir.",
      createdAt: Date.now(),
    });
    const community = require("../server/commerce/community"), crypto = require("node:crypto");
    await community.like(product.id, { uid: "member" }, { liked: true, expectedRevision: 0, mutationId: crypto.randomUUID() });
    await community.like(product.id, { visitorToken: community.issueVisitor().visitorToken }, { liked: true, expectedRevision: 0, mutationId: crypto.randomUUID() });
    process.once("SIGTERM", () => fixture.close().then(() => process.exit(0)));
    console.log(
      "Local integration fixture: real Express services with isolated in-memory Firebase adapters. No production data or email.",
    );
  } else {
    const { app } = require("../server");
    const server = require("node:http").createServer((req, res) =>
      requestWrapper(req, res, app),
    );
    configureHttpServer(server);
    server.listen(Number(process.env.PORT), "0.0.0.0");
    process.once("SIGTERM", () => server.close(() => process.exit(0)));
  }
}
start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
