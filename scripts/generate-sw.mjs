// Generates dist/sw.js from scripts/sw.template.js after `astro build`:
// walks dist/ for the precache list and stamps a content-hash cache version,
// so every deploy invalidates the previous cache exactly once.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(dist)
  .map((f) => relative(dist, f).split(sep).join('/'))
  .filter((f) => f !== 'sw.js')
  .sort();

// Precache URLs are relative to the SW scope, so the same sw.js works at any
// base path. Directory indexes are cached under their pretty URL.
const urls = files.map((f) => {
  if (f === 'index.html') return '';
  if (f.endsWith('/index.html')) return f.slice(0, -'index.html'.length);
  return f;
});

const hash = createHash('sha256');
for (const f of files) {
  hash.update(f);
  hash.update(readFileSync(join(dist, f)));
}
const version = hash.digest('hex').slice(0, 12);

const template = readFileSync(join(root, 'scripts', 'sw.template.js'), 'utf8');
writeFileSync(
  join(dist, 'sw.js'),
  template
    .replace('__CACHE_VERSION__', version)
    .replace('__PRECACHE_MANIFEST__', JSON.stringify(urls))
);

console.log(`sw.js generated: ${urls.length} files precached, cache savelock-${version}`);
