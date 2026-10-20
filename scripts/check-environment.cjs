'use strict';

const env = require('../server/config/env');
const { shopierReadiness } = require('../server/config/shopier');
const report = env.configurationReport();
const shopier = shopierReadiness();
const result = { ready: report.ready && (!shopier.enabled || shopier.configured),
  missing: report.missing, warnings: report.warnings, capabilities: report.capabilities,
  adminTransientStore: report.adminTransientStore, rateLimitStore: report.rateLimitStore,
  shopier: { enabled: shopier.enabled, configured: shopier.configured, blockers: shopier.enabled ? shopier.blockers : [] } };
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.ready ? 0 : 1;
