"use strict";
const fs = require("node:fs");
async function main() {
  const base = new URL(process.argv[2] || "");
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("HTTPS_BASE_ORIGIN_REQUIRED");
  const evidence = JSON.parse(
    fs.readFileSync(
      require("node:path").join(__dirname, "../validation-evidence.json"),
      "utf8",
    ),
  );
  const get = async (path) => {
    const r = await fetch(new URL(path, base), {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, body: await r.json() };
  };
  const health = await get("/healthz");
  if (
    health.status !== 200 ||
    health.body.release?.version !== require("../package.json").version ||
    health.body.release?.sourceDigest !== evidence.sourceDigest ||
    health.body.release?.buildVerified !== true
  )
    throw new Error("LIVE_RELEASE_IDENTITY_OR_BUILD_MISMATCH");
  const ready = await get("/readyz");
  if (ready.status !== 200 || ready.body.ok !== true)
    throw new Error("LIVE_DEPENDENCIES_NOT_READY");
  const catalog = await get("/api/store/catalog");
  if (
    catalog.status !== 200 ||
    !catalog.body.catalog?.products?.length ||
    catalog.body.catalog.stockVerified !== true
  )
    throw new Error("LIVE_CATALOG_OR_STOCK_UNVERIFIED");
  const details = await get(
    "/api/store/commerce/products/" +
      encodeURIComponent(catalog.body.catalog.products[0].id),
  );
  if (details.status !== 200 || !details.body.result?.product)
    throw new Error("LIVE_COMMERCE_METADATA_UNVERIFIED");
  const privateAccount = await get("/api/store/account");
  if (![401, 403].includes(privateAccount.status))
    throw new Error("LIVE_AUTH_BOUNDARY_FAILED");
  console.log(
    JSON.stringify({
      result: "PASS",
      version: health.body.release.version,
      sourceDigest: evidence.sourceDigest,
      scope:
        "release identity, dependencies, catalog/stock and unauthenticated account boundary; no payment was executed",
    }),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
