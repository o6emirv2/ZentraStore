'use strict';
const { performance } = require('node:perf_hooks');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
async function main() {
  const fixture = await applicationFixture({ transientStore: 'memory', rateLimitStore: 'memory', appCheckMode: 'monitor' });
  try {
    const results = [];
    for (const path of ['/api/store/catalog', '/api/store/links', '/api/store/account']) {
      const times = [];
      for (let index = 0; index < 21; index++) {
        const start = performance.now(), response = await fixture.request(path, path.endsWith('/account') ? { uid: 'member' } : {});
        if (response.status !== 200) throw new Error('PERFORMANCE_REQUEST_FAILED');
        if (index > 0) times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      const p95Ms = Number(times[Math.ceil(times.length * .95) - 1].toFixed(2));
      results.push({ path, samples: times.length, medianMs: Number(times[Math.floor(times.length / 2)].toFixed(2)), p95Ms });
      if (p95Ms > 2000) throw new Error('CONTROLLED_LATENCY_THRESHOLD_EXCEEDED');
    }
    console.log(JSON.stringify({ result: 'PASS', scope: 'Local HTTP, real Express/business services, in-memory Firebase boundary; not a production load benchmark', results }));
  } finally { await fixture.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
