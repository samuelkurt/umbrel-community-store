#!/usr/bin/env node
'use strict';
// Both Umbrel apps run the code in samuelkurt-blockhaus/src. umbrelOS copies only docker-compose.yml, hooks/ and
// umbrel-app.yml when an app is updated (never src/), so the code is shipped as hooks/blockhaus-src.tar.gz; the container
// mounts hooks/ and unpacks the archive into a tmpfs /app at every start (see docker-compose.yml). Run this after every change in samuelkurt-blockhaus/src; src/test/solo-sync.test.js fails when an archive
// is out of date. The archives are reproducible: unchanged code gives an unchanged file.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const from = path.join(root, 'samuelkurt-blockhaus', 'src');
const APPS = ['samuelkurt-blockhaus', 'samuelkurt-blockhaus-solo'];
const EXCLUDE = ['test', 'node_modules', '.DS_Store'];
const NAME = 'blockhaus-src.tar.gz';

// an older layout shipped a copy of the code folder in Solo; it would only be a stale second version
fs.rmSync(path.join(root, 'samuelkurt-blockhaus-solo', 'src'), { recursive: true, force: true });

const tarArgs = ['--format=ustar', '--sort=name', '--mtime=2026-01-01 00:00:00 UTC', '--owner=0', '--group=0', '--numeric-owner', '--mode=a+rX,u+w,go-w', ...EXCLUDE.map((e) => `--exclude=${e}`), '-cf', '-', '-C', from, '.'];
const tar = execFileSync('tar', tarArgs, { maxBuffer: 256 * 1024 * 1024 });
const gz = execFileSync('gzip', ['-9n'], { input: tar, maxBuffer: 256 * 1024 * 1024 });
for (const app of APPS) {
  const hooks = path.join(root, app, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, NAME), gz);
  fs.rmSync(path.join(hooks, 'pre-start'), { force: true }); // 0.7.1/0.7.2 used a host script; it needed the executable bit, which git/zip lose
}
fs.copyFileSync(path.join(root, 'samuelkurt-blockhaus', 'icon.svg'), path.join(root, 'samuelkurt-blockhaus-solo', 'icon.svg'));
console.log(`packed ${path.relative(root, from)} -> hooks/${NAME} in ${APPS.join(', ')} (${(gz.length / 1024).toFixed(0)} KB)`);
