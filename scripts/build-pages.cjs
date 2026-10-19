'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'dist-pages');
const allowed = ['index.html', 'style.css', 'script.js', 'CNAME', 'admin', 'public'];
function copy(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Static publish refuses symbolic links: ' + path.relative(root, source));
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(destination, name));
  } else if (stat.isFile()) { fs.copyFileSync(source, destination); }
  else throw new Error('Unsupported static source: ' + path.relative(root, source));
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output);
for (const name of allowed) copy(path.join(root, name), path.join(output, name));
fs.writeFileSync(path.join(output, '.nojekyll'), '');
console.log('GitHub Pages frontend prepared in dist-pages; backend, tests, dependencies and private configuration excluded.');
