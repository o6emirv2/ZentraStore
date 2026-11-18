"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, owner, clerk;
before(async () => {
  f = await applicationFixture();
  owner = await f.openAdmin();
  f.users.set("clerk", {
    uid: "clerk",
    email: "clerk@zentra.invalid",
    emailVerified: true,
    disabled: false,
    password: f.password,
    generation: 0,
  });
  f.db.records.set("adminUsers/clerk", {
    email: "clerk@zentra.invalid",
    role: "orders",
    active: true,
    policyVersion: 1,
  });
  clerk = await f.openAdmin("clerk");
});
after(async () => f?.close());
const row = (extra = {}) => ({
  uid: "member",
  paymentMethod: "wallet",
  status: "paid",
  approvedAt: Date.now(),
  totalKurus: 500,
  items: [],
  updatedAt: 1,
  ...extra,
});
test("orders staff cannot refund a paid wallet order without financial permission", async () => {
  f.db.records.set("storeOrders/role-refund", row());
  const balance = f.db.records.get("users/member").storeBalanceKurus;
  const result = await f.adminWrite(
    clerk,
    "/api/admin/store/orders/role-refund",
    "PATCH",
    { status: "refunded" },
  );
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "ADMIN_FINANCIAL_PERMISSION_REQUIRED");
  assert.equal(f.db.records.get("users/member").storeBalanceKurus, balance);
  assert.equal(f.db.records.get("storeOrders/role-refund").status, "paid");
});
test("orders staff cannot confirm Telegram payments with an administrator checkbox", async () => {
  f.db.records.set(
    "storeOrders/role-payment",
    row({
      paymentMethod: "telegram",
      status: "awaiting_payment",
      approvedAt: 0,
    }),
  );
  const r = await f.adminWrite(
    clerk,
    "/api/admin/store/orders/role-payment",
    "PATCH",
    {
      status: "paid",
      paymentConfirmed: true,
      paymentReference: "EXTERNAL-REFERENCE",
    },
  );
  assert.equal(r.status, 403);
  assert.equal(
    f.db.records.get("storeOrders/role-payment").status,
    "awaiting_payment",
  );
});
test("nonfinancial order review remains allowed for an order clerk", async () => {
  const r = await f.adminWrite(
    clerk,
    "/api/admin/store/orders/role-payment",
    "PATCH",
    { status: "payment_review" },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.order.status, "payment_review");
});
test("authorized refunds commit exactly once and leave an auditable ledger", async () => {
  const balance = f.db.records.get("users/member").storeBalanceKurus;
  const r = await f.adminWrite(
    owner,
    "/api/admin/store/orders/role-refund",
    "PATCH",
    { status: "refunded" },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.order.paymentState, "refunded");
  assert.equal(
    f.db.records.get("users/member").storeBalanceKurus,
    balance + 500,
  );
  assert.equal(
    f.db.records.get("storeWalletLedger/refund_role-refund").amountKurus,
    500,
  );
});
const content = {
  expectedRevision: 0,
  categories: [
    {
      id: "selected",
      name: "Seçilen ürünler",
      description: "Gerçek ürün grubu",
      enabled: true,
      productIds: ["kingmod"],
    },
  ],
  banners: [
    {
      id: "now-banner",
      title: "Güncel vitrin",
      message: "Gerçek mağaza içeriği",
      image: "",
      href: "/magaza",
      enabled: true,
      startsAt: 0,
      endsAt: 0,
    },
    {
      id: "scheduled-banner",
      title: "Gelecek vitrin",
      message: "Henüz başlamadı",
      image: "",
      href: "/magaza",
      enabled: true,
      startsAt: Date.now() + 86400000,
      endsAt: 0,
    },
  ],
};
test("category/banner publishing requires authorization and a body-bound action proof", async () => {
  const denied = await f.request("/api/admin/store/experience", {
    uid: "member",
    method: "PUT",
    body: content,
  });
  assert.equal(denied.status, 403);
  const noProof = await f.request("/api/admin/store/experience", {
    ...owner,
    method: "PUT",
    body: content,
  });
  assert.equal(noProof.status, 401);
  assert(!f.db.records.has("storefrontExperience/main"));
});
test("merchandising changes persist with revisions, audit records and scheduled visibility", async () => {
  const r = await f.adminWrite(
    owner,
    "/api/admin/store/experience",
    "PUT",
    content,
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.experience.revision, 1);
  const read = await f.request("/api/store/experience");
  assert.equal(read.status, 200);
  assert.equal(read.body.experience.categories[0].productIds[0], "kingmod");
  assert.deepEqual(
    read.body.experience.banners.map((x) => x.id),
    ["now-banner"],
  );
  assert(
    [...f.db.records.values()].some(
      (x) =>
        x.type === "store.content.update" ||
        x.action === "store.content.update",
    ),
  );
});
test("stale merchandising edits cannot overwrite a newer published revision", async () => {
  const r = await f.adminWrite(owner, "/api/admin/store/experience", "PUT", {
    ...content,
    banners: [],
  });
  assert.equal(r.status, 409);
  assert.equal(f.db.records.get("storefrontExperience/main").revision, 1);
});
test("unsafe banner destinations and unknown contract fields are rejected", async () => {
  const unsafe = {
    ...content,
    expectedRevision: 1,
    banners: [{ ...content.banners[0], href: "https://evil.invalid" }],
  };
  assert.equal(
    (await f.adminWrite(owner, "/api/admin/store/experience", "PUT", unsafe))
      .status,
    400,
  );
  assert.equal(
    (
      await f.adminWrite(owner, "/api/admin/store/experience", "PUT", {
        ...content,
        expectedRevision: 1,
        isOwner: true,
      })
    ).status,
    400,
  );
});
test("failed merchandising transactions preserve the published version", async () => {
  const service = require("../server/core/merchandisingService"),
    previous = structuredClone(f.db.records.get("storefrontExperience/main"));
  f.db.setFailure(true);
  await assert.rejects(
    service.updateExperience(
      { ...content, expectedRevision: 1, banners: [] },
      { uid: "owneruid" },
    ),
  );
  f.db.setFailure(false);
  assert.deepEqual(f.db.records.get("storefrontExperience/main"), previous);
});
test("direct storefront pages respond successfully with canonical and private indexing rules", async () => {
  for (const path of [
    "/magaza",
    "/kategori/ios",
    "/sepet",
    "/hesabim",
    "/siparisler",
  ]) {
    const r = await fetch(f.origin + path);
    assert.equal(r.status, 200, path);
    const html = await r.text();
    assert(html.includes('name="viewport"'));
    assert(
      html.includes(
        "initial-scale=0.85, viewport-fit=cover",
      ),
    );
    if (["/sepet", "/hesabim", "/siparisler"].includes(path))
      assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  }
});
test("product URLs render escaped metadata and JSON-LD without needing client execution", async () => {
  const r = await fetch(f.origin + "/urun/kingmod");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert(html.includes("application/ld+json"));
  assert(html.includes("<h1>KİNGMOD</h1>"));
  const description =
    /<meta\b(?=[^>]*\bname="description")[^>]*\bcontent="([^"]+)"/.exec(
      html,
    )?.[1];
  const ogTitle =
    /<meta\b(?=[^>]*\bproperty="og:title")[^>]*\bcontent="([^"]+)"/.exec(
      html,
    )?.[1];
  assert.equal(ogTitle, "KİNGMOD");
  assert(description && !description.startsWith("Zentra Store:"));
  assert(html.includes("kingmod-optimized.webp"));
  const data = JSON.parse(
    /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(html)[1],
  );
  assert.equal(data["@type"], "Product");
  assert.equal(data.sku, "kingmod");
  assert.equal(data.offers.priceCurrency, "TRY");
  assert.equal(
    (await fetch(f.origin + "/urun/nonexistent-product")).status,
    404,
  );
});
test("robots excludes private areas and sitemap lists actual active products", async () => {
  const robots = await (await fetch(f.origin + "/robots.txt")).text();
  assert(robots.includes("Disallow: /admin/"));
  assert(robots.includes("Disallow: /siparisler"));
  const sitemap = await (await fetch(f.origin + "/sitemap.xml")).text();
  assert(sitemap.includes("/urun/kingmod"));
  assert(!sitemap.includes("/hesabim"));
});
test("new admin bundles are served but private API access remains denied to guests", async () => {
  for (const path of [
    "/admin/portal.js",
    "/admin/workspace.js",
    "/admin/metrics.mjs",
    "/public/js/app/device.js",
    "/public/js/app/device.mjs",
    "/public/js/app/motion.mjs",
    "/public/js/app/gallery.mjs",
    "/public/css/device.css",
    "/admin/zentra-admin.css",
  ])
    assert.equal((await fetch(f.origin + path)).status, 200, path);
  assert.equal((await f.request("/api/admin/store/orders")).status, 401);
});
test("structured-data serialization cannot terminate its data script", () => {
  const v = require("../server/core/storefrontSeo").jsonLd({
    description: "</script><script>alert(1)</script>",
  });
  assert(!v.includes("<"));
  assert.equal(JSON.parse(v).description, "</script><script>alert(1)</script>");
});

test("unrecognized historical payment channels are preserved and never displayed as verified wallet payments", async () => {
  const original = row({
    paymentMethod: "retired_external",
    approvedAt: Date.now(),
  });
  f.db.records.set("storeOrders/legacy-channel", original);
  const result = await f.request("/api/store/orders?limit=40", {
    uid: "member",
  });
  assert.equal(result.status, 200);
  const order = result.body.orders.find((x) => x.id === "legacy-channel");
  assert.equal(order.paymentMethod, "unknown");
  assert.equal(order.paymentState, "unverified");
  assert.equal(order.cancellable, false);
  assert.equal(
    f.db.records.get("storeOrders/legacy-channel").paymentMethod,
    original.paymentMethod,
  );
});

test("removed marketing sections never reappear in direct home, listing, detail or account HTML", async () => {
  for (const path of [
    "/",
    "/magaza",
    "/urun/kingmod",
    "/hesabim?islem=kayit",
  ]) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    if (path === "/") {
      for (const id of ["catalog","productSearch","customerApp","authSheet"]) assert(html.includes('id="' + id + '"'),id);
      continue;
    }
    assert(!html.includes('class="hero"'), path);
    assert(!html.includes("home-hero-template"), path);
    assert(!html.includes("auth-visual"), path);
    assert(!html.includes("DİJİTAL ÜRÜN MAĞAZASI"), path);
    assert(html.includes('data-session-visible="guest"'), path);
    assert(html.includes('data-session-visible="signed" hidden'), path);
  }
});
test("direct registration requests keep their account route, show a neutral shell and stay unindexed", async () => {
  const response = await fetch(f.origin + "/hesabim?islem=kayit");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert(html.includes("<h1>Kayıt Ol</h1>"));
  assert(!html.includes("Senin için<br/>yeni bir başlangıç."));
  assert(html.includes("home-trust-template"));
});
