'use strict';
const env = require('../server/config/env');
const report = env.configurationReport();
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.ready ? 0 : 1;
