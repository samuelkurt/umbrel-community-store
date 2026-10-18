'use strict';
// Guards the install: the host ports this app publishes must not collide with what the Crafty app (denny-crafty)
// publishes (TCP 25500-25600, UDP 19132, 18123), or `docker compose up` fails with "port is already allocated".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CRAFTY_TCP = [[25500, 25600], [18123, 18123]];
const text = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');
const published = [...text.matchAll(/^\s*-\s*"?(\d+)(?:-(\d+))?:\d+(?:-\d+)?(\/udp)?"?\s*$/gm)].map((m) => ({ lo: Number(m[1]), hi: Number(m[2] || m[1]), udp: !!m[3] }));

test('published host ports do not collide with the Crafty app', () => {
  assert.ok(published.length >= 1, 'the pack port is published');
  for (const p of published.filter((x) => !x.udp)) {
    for (const [lo, hi] of CRAFTY_TCP) assert.ok(p.hi < lo || p.lo > hi, `host port ${p.lo}-${p.hi} lies in Crafty's ${lo}-${hi}`);
  }
});

test('PACK_PORT in the compose file is the published port', () => {
  const env = Number(/PACK_PORT:\s*(\d+)/.exec(text)[1]);
  assert.ok(published.some((p) => p.lo === env && p.hi === env), 'PACK_PORT is published 1:1');
});
