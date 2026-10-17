'use strict';

// Operator-only setup. Never invoke from a browser and never print the returned signing tokens.
const fs = require('node:fs');
const path = require('node:path');
const { API_BASE, getShopierConfig } = require('../server/config/shopier');
const { createShopierClient, providerId } = require('../server/core/shopierClient');
async function main() {
  const mode = process.argv[2];
  if (!['--register', '--check'].includes(mode)) throw Object.assign(new Error(), { code: 'USE_REGISTER_OR_CHECK' });
  const config = getShopierConfig();
  const required = config.blockers.filter((name) => ['SHOPIER_PAT', 'SHOPIER_API_BASE_URL', 'SHOPIER_WEBHOOK_URL', 'SHOPIER_HTTP_TIMEOUT_MS'].includes(name));
  if (required.length || config.apiBaseUrl !== API_BASE) throw Object.assign(new Error(), { code: 'SHOPIER_SETUP_CONFIGURATION_INVALID' });
  const client = createShopierClient({ config });
  const subscriptions = await client.listWebhooks();
  if (!Array.isArray(subscriptions)) throw Object.assign(new Error(), { code: 'SHOPIER_RESPONSE_INVALID' });
  const events = ['order.created', 'refund.updated'];
  if (mode === '--check') {
    const status = events.map((event) => ({ event, registered: subscriptions.some((row) => row.event === event && row.url === config.webhookUrl) }));
    process.stdout.write(JSON.stringify({ webhookUrl: config.webhookUrl, subscriptions: status, signingTokensVerified: false }) + '\n');
    if (status.some((row) => !row.registered)) process.exitCode = 1;
    return;
  }
  const target = path.resolve('shopier-webhook-secrets.env');
  // Exclusive creation prevents losing the once-only token from an earlier registration.
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeSync(fd, '# PRIVATE: copy tokens to Render Environment, then securely remove this file. Never commit or package.\n');
    for (const event of events) {
      if (subscriptions.some((row) => row.event === event && row.url === config.webhookUrl)) {
        process.stdout.write(`${event}: already registered; retain its existing Render token.\n`); continue;
      }
      const row = await client.createWebhook({ event, url: config.webhookUrl });
      providerId(row?.id);
      if (row.event !== event || row.url !== config.webhookUrl || typeof row.token !== 'string' || !/^[^\s<>]{16,4096}$/.test(row.token)) throw Object.assign(new Error(), { code: 'SHOPIER_SUBSCRIPTION_RESPONSE_INVALID' });
      const name = event === 'order.created' ? 'SHOPIER_WEBHOOK_TOKEN' : 'SHOPIER_REFUND_WEBHOOK_TOKEN';
      fs.writeSync(fd, `${name}=${row.token}\n`); fs.fsyncSync(fd);
      process.stdout.write(`${event}: registered; signing token saved to private setup file.\n`);
    }
  } finally { fs.closeSync(fd); }
  process.stdout.write('Private setup file: shopier-webhook-secrets.env (permissions 0600). No charge or refund was performed.\n');
}
main().catch((error) => { process.stderr.write(JSON.stringify({ ok: false, code: String(error.code || 'SHOPIER_SETUP_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 80) }) + '\n'); process.exitCode = 1; });
