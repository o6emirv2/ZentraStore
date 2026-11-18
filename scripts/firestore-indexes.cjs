"use strict";
const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== "--apply") || flags.length > 1) {
  console.error("Usage: node scripts/firestore-indexes.cjs [--apply]");
  process.exitCode = 1;
} else
  require("../server/core/firestoreIndexService")
    .reconcile({ apply: flags.includes("--apply") })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ready) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          ready: false,
          code: error.code || "FIRESTORE_INDEX_CHECK_FAILED",
          ...(error.providerStatus ? { status: error.providerStatus } : {}),
          ...(error.providerCode ? { providerCode: error.providerCode } : {}),
          ...(error.indexOperation ? { operation: error.indexOperation } : {}),
          ...(error.providerFields ? { fields: error.providerFields } : {}),
        }),
      );
      process.exitCode = 1;
    });
