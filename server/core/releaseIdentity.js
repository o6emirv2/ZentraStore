"use strict";
let identity;
function releaseIdentity() {
  if (identity) return identity;
  const { sourceDigest, validationEvidence } = require("./securityAssessment"),
    digest = sourceDigest(),
    evidence = validationEvidence();
  identity = Object.freeze({
    version: require("../../package.json").version,
    sourceDigest: digest,
    commit: /^[a-f0-9]{40}$/.test(process.env.RENDER_GIT_COMMIT || "")
      ? process.env.RENDER_GIT_COMMIT
      : "",
    buildVerified:
      evidence.sourceDigest === digest &&
      evidence.regression?.exitCode === 0 &&
      evidence.regression?.failed === 0 &&
      evidence.dependencies?.verified === true &&
      evidence.dependencies?.vulnerabilities === 0,
  });
  return identity;
}
module.exports = { releaseIdentity };
