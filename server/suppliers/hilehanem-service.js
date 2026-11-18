"use strict";

const { fromEnvironment } = require("./hilehanem-config");
const REQUIREMENTS = Object.freeze([
  "api_base_url", "authentication", "account_balance", "product_catalog",
  "package_stock_price", "purchase", "idempotency", "order_lookup", "license_response",
]);

function status({ config = fromEnvironment() } = {}) {
  return {
    ...config,
    active: false,
    state: config.configured ? "contract_required" : "configuration_required",
    contractVerified: false,
    balanceUsdCents: null,
    currency: "USD",
    lastSuccessAt: 0,
    automaticPurchasing: false,
    stockSynchronization: false,
    requirements: [...REQUIREMENTS],
  };
}

async function check(actor, { config = fromEnvironment(), db } = {}) {
  const database = db || require("../config/firebaseAdmin").initFirebaseAdmin().db;
  if (!database) throw Object.assign(new Error("STORE_STORAGE_UNAVAILABLE"), {
    code: "STORE_STORAGE_UNAVAILABLE", statusCode: 503,
  });
  const connection = status({ config });
  await database.collection("audit").doc().set({
    type: "supplier-configuration-check",
    action: "supplier.hilehanem.configuration",
    uid: String(actor?.uid || ""),
    result: "blocked",
    code: config.configured ? "HILEHANEM_API_CONTRACT_REQUIRED" : "HILEHANEM_CONFIGURATION_REQUIRED",
    at: Date.now(),
  });
  return connection;
}

module.exports = { status, check };
