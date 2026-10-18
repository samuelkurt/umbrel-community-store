'use strict';
// Building blocks of the standalone mode: Server List Ping and the Java downloader.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const mcping = require('../lib/mcping');
const java = require('../lib/java');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-solo-'));

// ---- mcping -------------------------------------------------------------------------------------------------------
function fakeMc(json, { split = false, garbage = false } = {}) {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => {
      let buf = Buffer.alloc(0); let replied = false;
      s.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        // handshake + status request both arrived -> answer
        if (replied || buf.length < 4) return;
        const l1 = mcping.readVarInt(buf, 0); if (!l1 || buf.length < l1.next + l1.value) return;
        const rest = buf.subarray(l1.next + l1.value);
        const l2 = mcping.readVarInt(rest, 0); if (!l2 || rest.length < l2.next + l2.value) return;
        replied = true;
        if (garbage) { s.write(Buffer.from('HTTP/1.1 200 OK\r\n\r\n')); return; }
        const reply = mcping.packet(0, mcping.str(JSON.stringify(json)));
        if (split) { s.write(reply.subarray(0, 3)); setTimeout(() => s.write(reply.subarray(3)), 40); } else s.write(reply);
      });
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('mcping: reads players, version and MOTD (also when the reply arrives in pieces)', async () => {
  const json = { version: { name: '26.3', protocol: 800 }, players: { online: 2, max: 8, sample: [{ name: 'Anna', id: 'x' }, { name: 'Ben', id: 'y' }] }, description: { text: 'Hallo ', extra: [{ text: 'Welt' }] } };
  for (const split of [false, true]) {
    const srv = await fakeMc(json, { split });
    try {
      const r = await mcping.ping('127.0.0.1', srv.address().port);
      assert.deepEqual(r, { online: 2, max: 8, sample: ['Anna', 'Ben'], version: '26.3', protocol: 800, motd: 'Hallo Welt' });
    } finally { srv.close(); }
  }
});

test('mcping: a big MOTD (> 127 bytes, two-byte VarInt) and plain-string description work', async () => {
  const long = 'x'.repeat(400);
  const srv = await fakeMc({ version: { name: 'a', protocol: 1 }, players: { online: 0, max: 1 }, description: long });
  try { assert.equal((await mcping.ping('127.0.0.1', srv.address().port)).motd, long); } finally { srv.close(); }
});

test('mcping: errors are clear — nothing listening, garbage reply, silence', async () => {
  const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  await assert.rejects(mcping.ping('127.0.0.1', free, { timeout: 500 }));
  const g = await fakeMc({}, { garbage: true });
  try { await assert.rejects(mcping.ping('127.0.0.1', g.address().port, { timeout: 500 })); } finally { g.close(); }
  const mute = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => mute.on('listening', r));
  try { await assert.rejects(mcping.ping('127.0.0.1', mute.address().port, { timeout: 300 }), /Zeit/); } finally { mute.close(); }
});

// ---- java ---------------------------------------------------------------------------------------------------------
test('java.wanted: explicit > installer record > jar > Minecraft version table > 21', () => {
  assert.equal(java.wanted({ override: 17, installed: { java: 21 }, jarJava: 25, mc: '1.8' }), 17);
  assert.equal(java.wanted({ installed: { java: 21 }, jarJava: 25, mc: '1.8' }), 21);
  assert.equal(java.wanted({ jarJava: 25, mc: '1.8' }), 25);
  assert.equal(java.wanted({ mc: '26.3' }), 25);
  assert.equal(java.wanted({ mc: '1.21.4' }), 21);
  assert.equal(java.wanted({ mc: '1.20.4' }), 17);
  assert.equal(java.wanted({ mc: '1.20.5' }), 21);
  assert.equal(java.wanted({ mc: '1.17.1' }), 17);
  assert.equal(java.wanted({ mc: '1.16.5' }), 8);
  assert.equal(java.wanted({}), 21);
});

test('java.pickMajor: rounds up to a version Adoptium builds', () => {
  assert.equal(java.pickMajor(8), 8);
  assert.equal(java.pickMajor(16), 17);
  assert.equal(java.pickMajor(22), 25);
  assert.equal(java.pickMajor(99), 25);
});

function adoptium({ badSum = false, noBin = false, empty = false } = {}) {
  const w = tmpdir();
  const root = path.join(w, 'jdk-21.0.1+12-jre');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  if (!noBin) fs.writeFileSync(path.join(root, 'bin', 'java'), '#!/bin/sh\necho "openjdk version \\"21.0.1\\"" >&2\nexit 0\n', { mode: 0o755 });
  else fs.writeFileSync(path.join(root, 'README'), 'x');
  const tgz = path.join(w, 'jre.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', w, 'jdk-21.0.1+12-jre']);
  const data = fs.readFileSync(tgz);
  const sum = badSum ? '0'.repeat(64) : crypto.createHash('sha256').update(data).digest('hex');
  const hits = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url.startsWith('/v3/assets/latest/21/hotspot')) {
        res.setHeader('content-type', 'application/json');
        const u = new URL(req.url, 'http://x');
        hits.push(Object.fromEntries(u.searchParams));
        return res.end(JSON.stringify(empty ? [] : [{ binary: { package: { name: 'jre.tar.gz', size: data.length, checksum: sum, link: `http://127.0.0.1:${srv.address().port}/dl/jre.tar.gz` } } }]));
      }
      if (req.url === '/dl/jre.tar.gz') { res.setHeader('content-length', data.length); return res.end(data); }
      res.statusCode = 404; res.end('no');
    }).listen(0, '127.0.0.1', () => resolve({ srv, hits, url: `http://127.0.0.1:${srv.address().port}/v3` }));
  });
}

test('java.ensure: downloads, verifies the checksum, unpacks, reuses; parallel calls share one download', async () => {
  process.env.BLOCKHAUS_ALLOW_PRIVATE = '1';
  const a = await adoptium();
  process.env.BLOCKHAUS_ADOPTIUM = a.url;
  const data = tmpdir();
  try {
    const msgs = [];
    const [r1, r2] = await Promise.all([java.ensure(data, 21, { say: (m) => msgs.push(m) }), java.ensure(data, 21)]);
    assert.equal(r1.bin, path.join(data, 'java', '21', 'bin', 'java'));
    assert.equal(r1.major, 21);
    assert.ok(fs.existsSync(r1.bin));
    assert.deepEqual(r1, r2);
    assert.equal(a.hits.filter((h) => h === '/dl/jre.tar.gz').length, 1, 'only one archive download');
    const q = a.hits.find((h) => typeof h === 'object');
    assert.equal(q.image_type, 'jre'); assert.equal(q.os, 'linux'); assert.equal(q.vendor, 'eclipse');
    assert.ok(msgs.some((m) => /entpackt/.test(m)));
    const again = await java.ensure(data, 21);
    assert.equal(again.downloaded, false);
    assert.equal(a.hits.filter((h) => h === '/dl/jre.tar.gz').length, 1);
    assert.deepEqual(java.installed(data), [21]);
    assert.deepEqual(fs.readdirSync(path.join(data, 'java')), ['21'], 'no temp folders left behind');
  } finally { a.srv.close(); delete process.env.BLOCKHAUS_ADOPTIUM; }
});

test('java.ensure: wrong checksum, missing bin/java and "no download for this CPU" all fail cleanly without leaving anything', async () => {
  process.env.BLOCKHAUS_ALLOW_PRIVATE = '1';
  for (const [opts, re] of [[{ badSum: true }, /Prüfsumme/], [{ noBin: true }, /bin\/java/], [{ empty: true }, /keinen Download/]]) {
    const a = await adoptium(opts);
    process.env.BLOCKHAUS_ADOPTIUM = a.url;
    const data = tmpdir();
    try {
      await assert.rejects(java.ensure(data, 21), re);
      assert.deepEqual(java.installed(data), []);
      const left = fs.existsSync(path.join(data, 'java')) ? fs.readdirSync(path.join(data, 'java')) : [];
      assert.deepEqual(left, [], 'temp folder removed');
    } finally { a.srv.close(); delete process.env.BLOCKHAUS_ADOPTIUM; }
  }
});

test('java.ensure: BLOCKHAUS_JAVA_<major> overrides the download (for tests and for people who bring their own)', async () => {
  process.env.BLOCKHAUS_JAVA_25 = process.execPath;
  try {
    const r = await java.ensure(tmpdir(), 25);
    assert.equal(r.bin, process.execPath);
  } finally { delete process.env.BLOCKHAUS_JAVA_25; }
});

const NET = process.env.NET === '1';
test('java.ensure (real Adoptium)', { skip: !NET, timeout: 300000 }, async () => {
  delete process.env.BLOCKHAUS_ALLOW_PRIVATE;
  const data = tmpdir();
  const r = await java.ensure(data, 21);
  const out = require('node:child_process').spawnSync(r.bin, ['-version'], { encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.match(out.stderr + out.stdout, /openjdk version "21\./);
});
