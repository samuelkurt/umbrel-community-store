'use strict';
// Guards the install: the host ports an app publishes must not collide with what the Crafty app (denny-crafty) publishes
// (TCP 25500-25600, UDP 19132, 18123) or with each other, or `docker compose up` fails with "port is already allocated"
// (that is how 0.4.0 failed on the Umbrel).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CRAFTY_TCP = [[25500, 25600], [18123, 18123]];
const CRAFTY_UDP = [[19132, 19132]];
const root = path.join(__dirname, '..', '..', '..');
const APPS = [
  { name: 'samuelkurt-blockhaus', file: path.join(root, 'samuelkurt-blockhaus', 'docker-compose.yml') },
  { name: 'samuelkurt-blockhaus-solo', file: path.join(root, 'samuelkurt-blockhaus-solo', 'docker-compose.yml') },
  { name: 'samuelkurt-playit', file: path.join(root, 'samuelkurt-playit', 'docker-compose.yml') },
].filter((a) => fs.existsSync(a.file)).map((a) => {
  const text = fs.readFileSync(a.file, 'utf8');
  const published = [...text.matchAll(/^\s*-\s*"?(\d+)(?:-(\d+))?:(\d+)(?:-(\d+))?(\/udp)?"?\s*$/gm)].map((m) => ({ lo: Number(m[1]), hi: Number(m[2] || m[1]), inner: Number(m[3]), udp: !!m[5] }));
  return { ...a, text, published };
});
const overlap = (a, b) => !(a.hi < b.lo || a.lo > b.hi);

for (const app of APPS.filter((a) => a.published.length)) {
  test(`${app.name}: published host ports do not collide with the Crafty app`, () => {
    for (const p of app.published) {
      for (const [lo, hi] of p.udp ? CRAFTY_UDP : CRAFTY_TCP) assert.ok(!overlap(p, { lo, hi }), `host port ${p.lo}-${p.hi}${p.udp ? '/udp' : ''} lies in Crafty's ${lo}-${hi}`);
    }
  });
}

test('no two of our apps publish the same host port (they can be installed side by side)', () => {
  const seen = new Map();
  for (const app of APPS) for (const p of app.published) {
    const key = `${p.udp ? 'udp' : 'tcp'}:${p.lo}-${p.hi}`;
    for (const [k, owner] of seen) if (k.startsWith(p.udp ? 'udp' : 'tcp') && owner !== app.name) {
      const [lo, hi] = k.split(':')[1].split('-').map(Number);
      assert.ok(!overlap(p, { lo, hi }), `${app.name} and ${owner} both publish ${key}`);
    }
    seen.set(key, app.name);
  }
});

for (const app of APPS.filter((a) => /PACK_PORT:/.test(a.text))) {
  test(`${app.name}: PACK_PORT is published 1:1`, () => {
    const env = Number(/PACK_PORT:\s*(\d+)/.exec(app.text)[1]);
    assert.ok(app.published.some((p) => !p.udp && p.lo === env && p.hi === env && p.inner === env), 'PACK_PORT is published 1:1');
  });
}

test('Blockhaus Solo: the Minecraft port and the voice chat port are published, with the numbers the app uses', () => {
  const solo = APPS.find((a) => a.name === 'samuelkurt-blockhaus-solo');
  if (!solo) return;
  const mc = Number(/MC_PORT:\s*(\d+)/.exec(solo.text)[1]);
  assert.ok(solo.published.some((p) => !p.udp && p.lo === mc && p.inner === mc), 'MC_PORT published 1:1 (TCP)');
  assert.ok(solo.published.some((p) => p.udp && p.lo === 24454 && p.inner === 24454), 'Simple Voice Chat default 24454/udp published');
  assert.match(solo.text, /stop_grace_period:\s*\d+m/, 'Minecraft gets time to save on docker stop');
  assert.match(solo.text, /image:\s*node:22-bookworm-slim/, 'glibc image (Temurin does not run on Alpine)');
  assert.match(solo.text, /BLOCKHAUS_MODE:\s*local/);
  assert.match(solo.text, /\$\{APP_DATA_DIR\}\/servers:\/servers/);
});
