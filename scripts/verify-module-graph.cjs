'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..'), cache = new Map(), context = vm.createContext({});
const entries = [];
function walk(directory) {
  for (const row of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, row.name);
    if (row.isDirectory()) walk(filename); else if (/\.(?:m?js)$/.test(row.name)) entries.push(filename);
  }
}
walk(path.join(root, 'admin')); walk(path.join(root, 'public/js')); entries.push(path.join(root, 'script.js'));
function moduleFor(filename) {
  if (!cache.has(filename)) cache.set(filename, new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), { identifier: filename, context }));
  return cache.get(filename);
}
async function main() {
  for (const filename of entries) {
    const module = moduleFor(filename);
    if (module.status !== 'unlinked') continue;
    await module.link((specifier, parent) => {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw new Error(`Unsupported static module: ${specifier}`);
      const target = specifier.split('?')[0];
      const resolved = target.startsWith('/') ? path.join(root, target) : path.resolve(path.dirname(parent.identifier), target);
      if (!resolved.startsWith(root + path.sep)) throw new Error('Module escapes project root');
      return moduleFor(resolved);
    });
  }
  console.log(JSON.stringify({ modules: cache.size, result: 'PASS', execution: 'parse-and-link; browser code not evaluated' }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
