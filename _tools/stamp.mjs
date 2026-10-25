// usage: node _tools/stamp.mjs   (run from the site folder before committing)
// Adds ?v=<content hash> to style.css and js/*.js references in every HTML page,
// so browsers fetch the new file as soon as it changes instead of using a cached copy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const assets = ['style.css', ...fs.readdirSync('js').map(f => `js/${f}`)];
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 8);
const versions = Object.fromEntries(assets.map(a => [a, hash(a)]));

const pages = ['index.html', 'about.html', ...fs.readdirSync('projects').map(f => path.join('projects', f))]
  .filter(f => f.endsWith('.html'));
for (const page of pages) {
  let html = fs.readFileSync(page, 'utf8');
  for (const [asset, v] of Object.entries(versions)) {
    const name = asset.replace(/[.]/g, '\\.');
    html = html.replace(new RegExp(`((?:\\.\\./)?${name})(\\?v=[0-9a-f]+)?"`, 'g'), `$1?v=${v}"`);
  }
  fs.writeFileSync(page, html);
}
console.log(versions);
