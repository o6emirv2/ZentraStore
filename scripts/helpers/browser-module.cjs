'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
async function browserModule(relativePath, replacements = {}) {
  const root = path.resolve(__dirname, '../..'), sources = new Map();
  function url(filename) {
    if (sources.has(filename)) return sources.get(filename);
    let source = fs.readFileSync(filename, 'utf8');
    source = source.replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g, (_match, _quote, target) => `from ${JSON.stringify(url(path.resolve(path.dirname(filename), target.split('?')[0])))}`);
    for (const [find, replacement] of Object.entries(replacements)) source = source.replaceAll(find, replacement);
    const value = 'data:text/javascript;base64,' + Buffer.from(source + '\n// fixture ' + crypto.randomUUID()).toString('base64'); sources.set(filename, value); return value;
  }
  return import(url(path.resolve(root, relativePath)));
}
module.exports = { browserModule };
