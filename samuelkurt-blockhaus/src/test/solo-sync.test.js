'use strict';
// umbrelOS copies only docker-compose.yml, hooks/ and umbrel-app.yml when an app is updated, never src/. Both apps therefore
// carry the code as hooks/blockhaus-src.tar.gz and unpack it in hooks/pre-start. Run `node scripts/sync-solo.js` to refresh it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..', '..');
const a = path.join(root, 'samuelkurt-blockhaus', 'src');
const APPS = ['samuelkurt-blockhaus', 'samuelkurt-blockhaus-solo'];
const have = APPS.every((n) => fs.existsSync(path.join(root, n, 'hooks')));
const SKIP = new Set(['test', 'node_modules', '.DS_Store']);
const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (SKIP.has(e.name) ? [] : e.isDirectory() ? walk(path.join(dir, e.name), path.join(rel, e.name)) : [path.join(rel, e.name)])).sort();
const walkAll = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkAll(path.join(dir, e.name), path.join(rel, e.name)) : [path.join(rel, e.name)])).sort();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-hook-'));
const unpack = (tgz, to) => { fs.mkdirSync(to, { recursive: true }); execFileSync('tar', ['-xzf', tgz, '-C', to]); };

test('the apps carry exactly the code of Blockhaus (without tests) as hooks/blockhaus-src.tar.gz', { skip: !have }, () => {
  const fa = walk(a);
  for (const app of APPS) {
    const out = tmp(); unpack(path.join(root, app, 'hooks', 'blockhaus-src.tar.gz'), out);
    assert.deepEqual(walkAll(out), fa, `${app}: same files; run node scripts/sync-solo.js`);
    for (const f of fa) assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(out, f))), `${app}: ${f} differs; run node scripts/sync-solo.js`);
  }
  assert.ok(!fs.existsSync(path.join(root, 'samuelkurt-blockhaus-solo', 'src')), 'Solo has no src copy any more (it would only be a stale second version)');
  assert.ok(fs.readFileSync(path.join(root, 'samuelkurt-blockhaus', 'icon.svg')).equals(fs.readFileSync(path.join(root, 'samuelkurt-blockhaus-solo', 'icon.svg'))), 'icon');
});

test('both apps and the server code agree on the version', { skip: !have }, () => {
  const v = (f) => /^version:\s*"([^"]+)"/m.exec(fs.readFileSync(f, 'utf8'))[1];
  const code = /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(a, 'server.js'), 'utf8'))[1];
  for (const app of APPS) assert.equal(v(path.join(root, app, 'umbrel-app.yml')), code, app);
});

test('hooks/pre-start is executable (umbrelOS silently skips it otherwise) and the same in both apps', { skip: !have }, () => {
  const files = APPS.map((n) => path.join(root, n, 'hooks', 'pre-start'));
  for (const f of files) assert.ok(fs.statSync(f).mode & 0o100, `${f} must be executable (chmod +x)`);
  assert.ok(fs.readFileSync(files[0]).equals(fs.readFileSync(files[1])));
  assert.ok(fs.readFileSync(files[0], 'utf8').startsWith('#!/usr/bin/env bash\n'));
});

for (const withRsync of [true, false]) {
  test(`hooks/pre-start unpacks the code into src/ (${withRsync ? 'rsync' : 'without rsync'}): fresh install, update over an old version, and a second start`, { skip: !have }, () => {
    for (const app of APPS) {
      const appDir = tmp(); fs.cpSync(path.join(root, app, 'hooks'), path.join(appDir, 'hooks'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
      fs.chmodSync(path.join(appDir, 'hooks', 'pre-start'), 0o755);
      let PATH = process.env.PATH;
      if (!withRsync) {
        const bin = tmp();
        for (const c of ['bash', 'sed', 'head', 'tar', 'gzip', 'rm', 'mkdir', 'find', 'cp', 'chmod', 'dirname', 'env', 'cat']) {
          const r = spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
          if (r) fs.symlinkSync(r, path.join(bin, c));
        }
        PATH = bin;
      }
      const run = () => spawnSync(path.join(appDir, 'hooks', 'pre-start'), { env: { PATH }, encoding: 'utf8' });
      const want = walk(a);
      // fresh install: no src/ yet
      let r = run(); assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /Version \d+\.\d+\.\d+/);
      assert.deepEqual(walkAll(path.join(appDir, 'src')), want, app);
      // an old version: other files, a changed file, a leftover that no longer exists
      fs.writeFileSync(path.join(appDir, 'src', 'lib', 'gone-in-new-version.js'), 'old');
      fs.writeFileSync(path.join(appDir, 'src', 'server.js'), 'const VERSION = \'0.5.0\';');
      fs.mkdirSync(path.join(appDir, 'src', 'old-dir')); fs.writeFileSync(path.join(appDir, 'src', 'old-dir', 'x'), 'x');
      const inode = fs.statSync(path.join(appDir, 'src')).ino;
      r = run(); assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(walkAll(path.join(appDir, 'src')), want, `${app}: stale files are gone`);
      assert.ok(fs.readFileSync(path.join(appDir, 'src', 'server.js')).equals(fs.readFileSync(path.join(a, 'server.js'))));
      assert.equal(fs.statSync(path.join(appDir, 'src')).ino, inode, 'same folder, so a running container keeps its mount');
      assert.ok(!fs.readdirSync(appDir).some((n) => n.startsWith('.src-unpack')), 'no temp folder left');
      // second start: nothing changes
      r = run(); assert.equal(r.status, 0); assert.deepEqual(walkAll(path.join(appDir, 'src')), want);
      // a broken archive must not wipe the working code
      fs.writeFileSync(path.join(appDir, 'hooks', 'blockhaus-src.tar.gz'), 'kaputt');
      r = run(); assert.notEqual(r.status, 0); assert.deepEqual(walkAll(path.join(appDir, 'src')), want, 'old code is kept');
      fs.rmSync(path.join(appDir, 'hooks', 'blockhaus-src.tar.gz'));
      r = run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /fehlt/);
    }
  });
}
