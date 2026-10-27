'use strict';
// umbrelOS copies only docker-compose.yml, hooks/ and umbrel-app.yml when an app is updated, never src/. Both apps therefore
// carry the code as hooks/blockhaus-src.tar.gz; the container unpacks it into a tmpfs /app at every start. Run `node scripts/sync-solo.js` to refresh it.
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

for (const app of APPS) {
  test(`${app}: the container unpacks hooks/blockhaus-src.tar.gz into a fresh /app at every start (no script, no executable bit needed)`, { skip: !have }, () => {
    const text = fs.readFileSync(path.join(root, app, 'docker-compose.yml'), 'utf8');
    const cmd = /command:\s*\["sh",\s*"-c",\s*"([^"]+)"\]/.exec(text);
    assert.ok(cmd, 'command is sh -c "tar … && exec node …"');
    assert.match(text, /\$\{APP_DATA_DIR\}\/hooks:\/hooks:ro/, 'hooks/ (which umbrelOS copies on updates) is mounted read-only');
    assert.match(text, /tmpfs:\s*\n\s*-\s*\/app\b/, '/app is a tmpfs: nothing stale survives a restart');
    assert.ok(!/\$\{APP_DATA_DIR\}\/src:/.test(text), 'src/ is not mounted any more (umbrelOS never updates it)');
    assert.ok(!fs.existsSync(path.join(root, app, 'hooks', 'pre-start')), 'no host script (it needs the executable bit, which git and zip lose)');
    // run the very command of the compose file, with the container paths pointed at a temp folder
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cmd-'));
    fs.mkdirSync(path.join(base, 'app'));
    const line = cmd[1].replaceAll('/hooks/', path.join(root, app, 'hooks') + '/').replaceAll('/app', path.join(base, 'app')).replace(/exec node (\S+)/, "grep -m1 'const VERSION' $1");
    const r = spawnSync('sh', ['-c', line], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const code = /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(a, 'server.js'), 'utf8'))[1];
    assert.match(r.stdout, new RegExp(`const VERSION = '${code}'`));
    assert.deepEqual(walkAll(path.join(base, 'app')), walk(a), 'the unpacked code is exactly the code of Blockhaus');
    // a broken archive stops the container (restart: on-failure shows it in the log) instead of starting old code
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-bad-')); fs.writeFileSync(path.join(bad, 'blockhaus-src.tar.gz'), 'kaputt');
    const r2 = spawnSync('sh', ['-c', cmd[1].replaceAll('/hooks/', bad + '/').replaceAll('/app', path.join(base, 'app2')).replace(/exec node (\S+)/, 'echo started')], { encoding: 'utf8' });
    assert.notEqual(r2.status, 0); assert.ok(!/started/.test(r2.stdout));
  });
}
