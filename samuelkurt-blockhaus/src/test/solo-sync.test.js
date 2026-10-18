'use strict';
// Blockhaus Solo carries a copy of this code (an Umbrel app is one folder). Run `node scripts/sync-solo.js` to refresh it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const a = path.join(root, 'samuelkurt-blockhaus', 'src');
const b = path.join(root, 'samuelkurt-blockhaus-solo', 'src');
const SKIP = new Set(['test', 'node_modules', '.DS_Store']);
const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (SKIP.has(e.name) ? [] : e.isDirectory() ? walk(path.join(dir, e.name), path.join(rel, e.name)) : [path.join(rel, e.name)])).sort();

test('Blockhaus Solo ships exactly the code of Blockhaus (without tests)', { skip: !fs.existsSync(b) }, () => {
  const fa = walk(a); const fb = walk(b);
  assert.deepEqual(fb, fa, 'same files; run node scripts/sync-solo.js');
  for (const f of fa) assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))), `${f} differs; run node scripts/sync-solo.js`);
  assert.ok(fs.readFileSync(path.join(root, 'samuelkurt-blockhaus', 'icon.svg')).equals(fs.readFileSync(path.join(root, 'samuelkurt-blockhaus-solo', 'icon.svg'))), 'icon');
});

test('both apps and the server code agree on the version', { skip: !fs.existsSync(b) }, () => {
  const v = (f) => /^version:\s*"([^"]+)"/m.exec(fs.readFileSync(f, 'utf8'))[1];
  const code = /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(a, 'server.js'), 'utf8'))[1];
  assert.equal(v(path.join(root, 'samuelkurt-blockhaus', 'umbrel-app.yml')), code);
  assert.equal(v(path.join(root, 'samuelkurt-blockhaus-solo', 'umbrel-app.yml')), code);
});
