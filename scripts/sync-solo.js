#!/usr/bin/env node
'use strict';
// Blockhaus Solo ships the same code as Blockhaus; an Umbrel app is one folder, so the code is copied. Run this after
// every change in samuelkurt-blockhaus/src (src/test/solo-sync.test.js fails when the copies differ).
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const from = path.join(root, 'samuelkurt-blockhaus', 'src');
const to = path.join(root, 'samuelkurt-blockhaus-solo', 'src');
const SKIP = new Set(['test', 'node_modules', '.DS_Store']);

fs.rmSync(to, { recursive: true, force: true });
(function copy(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const e of fs.readdirSync(a, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(a, e.name); const d = path.join(b, e.name);
    if (e.isDirectory()) copy(s, d); else fs.copyFileSync(s, d);
  }
})(from, to);
fs.copyFileSync(path.join(root, 'samuelkurt-blockhaus', 'icon.svg'), path.join(root, 'samuelkurt-blockhaus-solo', 'icon.svg'));
console.log('synced', path.relative(root, from), '->', path.relative(root, to));
