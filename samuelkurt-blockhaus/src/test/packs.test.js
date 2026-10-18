'use strict';
// Texture packs: inspection, upload, merging, publishing, the public pack server and the Minecraft forwarding.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { createApp } = require('../server');
const { createMockCrafty } = require('./mock-crafty');
const zip = require('../lib/zip');
const packs = require('../lib/packs');
const { createPackFront } = require('../lib/packserver');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-packs-'));
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** Build a ZIP from {name: string|Buffer} and return its bytes. */
async function makeZip(files) {
  const dir = tmpdir(); const src = path.join(dir, 'src'); fs.mkdirSync(src);
  for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, n)), { recursive: true }); fs.writeFileSync(path.join(src, n), c); }
  const out = path.join(dir, 'x.zip'); const w = new zip.ZipWriter(fs.createWriteStream(out));
  await w.addTree(src, ''); await w.finish();
  return fs.readFileSync(out);
}
const mc = (pack, extra = {}) => JSON.stringify({ pack: { description: 'T', ...pack }, ...extra });
const listNames = async (file) => (await zip.readEntries(file)).map((e) => e.name);
async function inspectBuf(buf) { const f = path.join(tmpdir(), 'p.zip'); fs.writeFileSync(f, buf); return packs.inspect(f); }

async function setup({ jar = true } = {}) {
  const tmp = tmpdir(); const serversDir = path.join(tmp, 'servers'); const sdir = path.join(serversDir, 'uuid-1');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'server.properties'), 'level-name=world\nmax-players=20\nmotd=Hi\n');
  if (jar) {
    const j = await makeZip({ 'version.json': JSON.stringify({ id: '26.3', pack_version: { resource_major: 97, resource_minor: 1, data_major: 121, data_minor: 0 } }) });
    fs.writeFileSync(path.join(sdir, 'vanilla.jar'), j);
  }
  const mock = createMockCrafty(); await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const app = createApp({ dataDir: path.join(tmp, 'data'), serversDir, settleMs: 5 });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  app.config.update({ craftyUrl: `http://127.0.0.1:${mock.server.address().port}`, apiToken: 'tok123' });
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  };
  const upload = async (name, buf, headers = {}) => {
    const res = await fetch(`${base}/api/servers/uuid-1/packs/upload?name=${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Blockhaus': '1', ...headers }, body: buf });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  };
  const waitJob = async (id) => {
    for (let i = 0; i < 200; i++) {
      const r = await call('GET', `/api/servers/uuid-1/jobs/${id}`);
      if (r.json.status !== 'running') return r.json;
      await new Promise((x) => setTimeout(x, 50));
    }
    throw new Error('job timeout');
  };
  const close = () => { app.close(); mock.server.close(); app.closeAllConnections?.(); mock.server.closeAllConnections?.(); };
  return { tmp, sdir, app, call, upload, waitJob, close, dataDir: path.join(tmp, 'data') };
}
const S = '/api/servers/uuid-1';
const GOOD = { 'pack.mcmeta': mc({ min_format: [97, 1], max_format: [97, 1] }), 'pack.png': PNG, 'assets/minecraft/textures/block/stone.png': Buffer.from('stone-A') };

test('inspect: good pack, nested pack, wrong kinds of ZIP, odd names', async () => {
  let i = await inspectBuf(await makeZip(GOOD));
  assert.deepEqual(i.errors, []); assert.equal(i.prefix, ''); assert.equal(i.hasAssets, true); assert.equal(i.hasIcon, true);
  i = await inspectBuf(await makeZip({ 'MyPack/pack.mcmeta': mc({ pack_format: 46 }), 'MyPack/assets/minecraft/x.png': 'a' }));
  assert.deepEqual(i.errors, []); assert.equal(i.prefix, 'MyPack/'); assert.match(i.warnings[0], /Unterordner/);
  i = await inspectBuf(await makeZip({ 'a/pack.mcmeta': mc({ pack_format: 46 }), 'b/pack.mcmeta': mc({ pack_format: 46 }) }));
  assert.match(i.errors[0], /mehrere Pakete/);
  i = await inspectBuf(await makeZip({ 'manifest.json': '{}', 'textures/x.png': 'a' }));
  assert.match(i.errors[0], /Bedrock/);
  i = await inspectBuf(await makeZip({ 'data/minecraft/recipes/x.json': '{}' }));
  assert.match(i.errors[0], /Datenpaket/);
  i = await inspectBuf(await makeZip({ 'inner.zip': 'zzz' }));
  assert.match(i.errors[0], /noch ein ZIP/);
  i = await inspectBuf(await makeZip({ 'readme.txt': 'x' }));
  assert.match(i.errors[0], /fehlt die Datei pack\.mcmeta/);
  i = await inspectBuf(await makeZip({ 'pack.mcmeta': '{nope' }));
  assert.match(i.errors[0], /kein gültiges JSON/);
  i = await inspectBuf(await makeZip({ 'pack.mcmeta': '{}' }));
  assert.match(i.errors[0], /Abschnitt „pack“/);
  i = await inspectBuf(await makeZip({ 'pack.mcmeta': '﻿' + mc({ pack_format: 46 }), 'assets/minecraft/Textures/Stone Block.png': 'a' }));
  assert.deepEqual(i.errors, []); assert.match(i.warnings.join(' '), /Großbuchstaben/);
  assert.equal(i.description, 'T');
  i = await inspectBuf(Buffer.from('not a zip at all, definitely not'));
  assert.ok(i.errors.length);
});

test('metaProblems agrees with the rules taken from the real Minecraft 26.3 parser', () => {
  const ok = (p) => assert.deepEqual(packs.metaProblems(p), [], JSON.stringify(p));
  const no = (p, re) => { const r = packs.metaProblems(p); assert.ok(r.length, 'should fail: ' + JSON.stringify(p)); if (re) assert.match(r.join(' '), re); };
  ok({ pack_format: 46 }); ok({ pack_format: 64 }); ok({ pack_format: 46, supported_formats: [34, 64] });
  ok({ min_format: [97, 1], max_format: [97, 1] }); ok({ min_format: 65, max_format: 97 });
  ok({ pack_format: 34, supported_formats: [34, 64], min_format: 34, max_format: 97 });
  no({ pack_format: 69 }, /min_format und max_format/); no({ pack_format: 75, supported_formats: [46, 99] });
  no({}, /kein Pack-Format/); no({ min_format: 65 }, /beide/); no({ min_format: 99, max_format: 98 });
  no({ pack_format: 64, min_format: 65, max_format: 97 }, /nicht im Bereich/);
  no({ pack_format: 46, supported_formats: [34, 64], min_format: 65, max_format: 97 }, /veraltet/);
  no({ pack_format: 46, min_format: 46, max_format: 97 }, /supported_formats/);
  no({ pack_format: '46' }, /keine Zahl/);
  assert.match(packs.metaProblems({ pack_format: 46 }, false)[0], /description/);
});

test('formats: expected format from the server jar, compat labels', async () => {
  const t = await setup();
  try {
    const f = await packs.serverPackFormat(path.join(t.sdir, 'vanilla.jar'));
    assert.deepEqual(f.format, [97, 1]); assert.equal(f.style, 'minor'); assert.equal(f.mc, '26.3');
    const legacy = path.join(t.tmp, 'old.jar');
    fs.writeFileSync(legacy, await makeZip({ 'version.json': JSON.stringify({ id: '1.21.4', pack_version: { resource: 46, data: 61 } }) }));
    assert.deepEqual(await packs.serverPackFormat(legacy), { format: [46, 0], style: 'legacy', mc: '1.21.4' });
    assert.equal(await packs.serverPackFormat(path.join(t.tmp, 'nothing.jar')), null);
    assert.equal(packs.compat({ pack_format: 46 }, [97, 1]), 'too-old');
    assert.equal(packs.compat({ min_format: [97, 1], max_format: [97, 1] }, [97, 1]), 'ok');
    assert.equal(packs.compat({ min_format: 98, max_format: 99 }, [97, 1]), 'too-new');
    assert.equal(packs.compat({}, [97, 1]), 'unknown');
  } finally { t.close(); }
});

test('upload route: accepts a pack, repairs a nested one, refuses wrong ones, needs the upload headers', async () => {
  const t = await setup();
  try {
    let r = await t.upload('Faithful.zip', await makeZip(GOOD));
    assert.equal(r.status, 200, r.text);
    const id1 = r.json.pack.id;
    assert.equal(r.json.pack.repaired, false);
    r = await t.upload('Nested.zip', await makeZip({ 'Nested/pack.mcmeta': mc({ pack_format: 46 }), 'Nested/assets/minecraft/textures/block/dirt.png': 'd' }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.pack.repaired, true); assert.match(r.json.pack.warnings[0], /neu verpackt/);
    const stored = path.join(t.dataDir, 'packs/uuid-1/lib', r.json.pack.file);
    const names = await listNames(stored);
    assert.ok(names.includes('pack.mcmeta'), 'mcmeta at the root now: ' + names.join(','));
    assert.ok(names.includes('assets/minecraft/textures/block/dirt.png'));
    assert.equal(r.json.pack.sha1, sha1(fs.readFileSync(stored)));
    r = await t.upload('Bedrock.zip', await makeZip({ 'manifest.json': '{}' }));
    assert.equal(r.status, 422); assert.match(r.json.error, /Bedrock/);
    r = await t.upload('notazip.txt', Buffer.from('x'));
    assert.equal(r.status, 400);
    r = await t.upload('x.zip', Buffer.from('x'), { 'Content-Type': 'text/plain' });
    assert.equal(r.status, 415);
    assert.deepEqual(fs.readdirSync(path.join(t.dataDir, 'packs/uuid-1/lib')).filter((f) => f.startsWith('.')), [], 'no upload leftovers');
    r = await t.call('GET', `${S}/packs`);
    assert.equal(r.json.packs.length, 2);
    assert.equal(r.json.packs[0].name, 'Nested', 'newest on top');
    assert.equal(r.json.expected.mc, '26.3');
    assert.equal(r.json.packs[0].problems.length, 0, 'repaired nested pack with pack_format 46 is valid on 26.x');
    assert.equal(r.json.packs[0].compat, 'too-old');
    assert.ok(id1);
  } finally { t.close(); }
});

test('move / toggle / rename / delete', async () => {
  const t = await setup();
  try {
    const a = (await t.upload('A.zip', await makeZip(GOOD))).json.pack.id;
    const b = (await t.upload('B.zip', await makeZip(GOOD))).json.pack.id;
    let r = await t.call('GET', `${S}/packs`);
    assert.deepEqual(r.json.packs.map((p) => p.name), ['B', 'A']);
    await t.call('POST', `${S}/packs/move`, { id: b, dir: 'down' });
    await t.call('POST', `${S}/packs/toggle`, { id: a });
    await t.call('POST', `${S}/packs/rename`, { id: b, name: 'Bee' });
    r = await t.call('GET', `${S}/packs`);
    assert.deepEqual(r.json.packs.map((p) => [p.name, p.enabled]), [['A', false], ['Bee', true]]);
    r = await t.call('POST', `${S}/packs/delete`, { id: a });
    assert.equal(r.status, 200);
    assert.equal(fs.readdirSync(path.join(t.dataDir, 'packs/uuid-1/lib')).filter((f) => f.endsWith('.zip')).length, 1);
    r = await t.call('POST', `${S}/packs/delete`, { id: 'deadbeef' });
    assert.equal(r.status, 404);
  } finally { t.close(); }
});

test('apply: one pack is published unchanged, server.properties gets url / sha1 / id, other lines stay', async () => {
  const t = await setup();
  try {
    const buf = await makeZip(GOOD);
    await t.upload('One.zip', buf);
    let r = await t.call('POST', `${S}/packs/apply`, {});
    assert.equal(r.status, 400); assert.match(r.json.error, /öffentliche Adresse/);
    t.app.config.update({ publicAddress: 'my-tunnel.gl.at.ply.gg:41872' });
    r = await t.call('POST', `${S}/packs/apply`, {});
    assert.equal(r.status, 202);
    const job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'done', job.error);
    const stored = fs.readdirSync(path.join(t.dataDir, 'packs/uuid-1/lib')).find((f) => f.endsWith('.zip'));
    const pub = fs.readdirSync(path.join(t.dataDir, 'packs-public'));
    assert.equal(pub.length, 1);
    assert.match(pub[0], /^uuid-1-[0-9a-f]{40}\.zip$/);
    const pubFile = path.join(t.dataDir, 'packs-public', pub[0]);
    assert.ok(fs.readFileSync(pubFile).equals(fs.readFileSync(path.join(t.dataDir, 'packs/uuid-1/lib', stored))), 'single valid pack published byte-identical');
    assert.equal(job.result.sha1, sha1(fs.readFileSync(pubFile)));
    const props = fs.readFileSync(path.join(t.sdir, 'server.properties'), 'utf8');
    assert.match(props, new RegExp(`resource-pack=http\\\\://my-tunnel\\.gl\\.at\\.ply\\.gg\\\\:41872/p/${pub[0]}`));
    assert.match(props, new RegExp(`resource-pack-sha1=${job.result.sha1}`));
    assert.match(props, /resource-pack-id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    assert.match(props, /level-name=world\nmax-players=20\nmotd=Hi/);
    r = await t.call('GET', `${S}/packs`);
    assert.equal(r.json.applied.inSync, true);
    // disable everything -> published file removed, properties cleared
    const id = r.json.packs[0].id;
    await t.call('POST', `${S}/packs/toggle`, { id });
    r = await t.call('POST', `${S}/packs/apply`, {});
    const j2 = await t.waitJob(r.json.job.id);
    assert.equal(j2.result.cleared, true);
    assert.deepEqual(fs.readdirSync(path.join(t.dataDir, 'packs-public')), []);
    assert.match(fs.readFileSync(path.join(t.sdir, 'server.properties'), 'utf8'), /resource-pack=\n/);
  } finally { t.close(); }
});

test('apply: several packs are merged, top one wins, lang / sounds / atlases are combined', async () => {
  const t = await setup();
  try {
    t.app.config.update({ publicAddress: 'h.example:1' });
    await t.upload('Low.zip', await makeZip({
      'pack.mcmeta': mc({ min_format: [97, 1], max_format: [97, 1] }), 'pack.png': PNG,
      'assets/minecraft/textures/block/stone.png': 'LOW-stone', 'assets/minecraft/textures/block/dirt.png': 'LOW-dirt',
      'assets/minecraft/lang/en_us.json': JSON.stringify({ a: 'low-a', b: 'low-b' }),
      'assets/minecraft/sounds.json': JSON.stringify({ 'block.stone.break': { sounds: ['low/one'] }, 'only.low': { sounds: ['low/x'] } }),
      'assets/minecraft/atlases/blocks.json': JSON.stringify({ sources: [{ type: 'directory', source: 'low' }] }),
    }));
    await t.upload('High.zip', await makeZip({
      'pack.mcmeta': mc({ min_format: [97, 1], max_format: [97, 1] }, {}),
      'assets/minecraft/textures/block/stone.png': 'HIGH-stone', 'assets/minecraft/textures/block/sand.png': 'HIGH-sand',
      'assets/minecraft/lang/en_us.json': JSON.stringify({ b: 'high-b', c: 'high-c' }),
      'assets/minecraft/sounds.json': JSON.stringify({ 'block.stone.break': { sounds: ['high/two'] }, 'block.sand.break': { replace: true, sounds: ['high/s'] } }),
      'assets/minecraft/atlases/blocks.json': JSON.stringify({ sources: [{ type: 'directory', source: 'high' }] }),
    }));
    const r = await t.call('POST', `${S}/packs/apply`, {});
    const job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.result.packs, 2); assert.ok(job.result.merged >= 3); assert.equal(job.result.overwritten, 1);
    const pubFile = path.join(t.dataDir, 'packs-public', fs.readdirSync(path.join(t.dataDir, 'packs-public'))[0]);
    assert.ok(fs.statSync(pubFile).size > 0);
    const out = tmpdir(); await zip.extractZip(pubFile, out);
    const rd = (f) => fs.readFileSync(path.join(out, f), 'utf8');
    assert.equal(rd('assets/minecraft/textures/block/stone.png'), 'HIGH-stone');
    assert.equal(rd('assets/minecraft/textures/block/dirt.png'), 'LOW-dirt');
    assert.equal(rd('assets/minecraft/textures/block/sand.png'), 'HIGH-sand');
    assert.deepEqual(JSON.parse(rd('assets/minecraft/lang/en_us.json')), { a: 'low-a', b: 'high-b', c: 'high-c' });
    const snd = JSON.parse(rd('assets/minecraft/sounds.json'));
    assert.deepEqual(snd['block.stone.break'].sounds, ['low/one', 'high/two']);
    assert.deepEqual(snd['block.sand.break'].sounds, ['high/s']); assert.ok(snd['only.low']);
    assert.deepEqual(JSON.parse(rd('assets/minecraft/atlases/blocks.json')).sources.map((s) => s.source), ['low', 'high']);
    assert.ok(fs.existsSync(path.join(out, 'pack.png')), 'icon of the lower pack kept when the top one has none');
    const meta = JSON.parse(rd('pack.mcmeta'));
    assert.equal(meta.pack.description, 'Blockhaus: High + Low');
    assert.deepEqual(packs.metaProblems(meta.pack), []);
    // disabling the top one changes what is published
    const list = (await t.call('GET', `${S}/packs`)).json.packs;
    await t.call('POST', `${S}/packs/toggle`, { id: list[0].id });
    const r2 = await t.call('POST', `${S}/packs/apply`, {});
    const j2 = await t.waitJob(r2.json.job.id);
    assert.equal(j2.result.packs, 1);
    assert.equal(fs.readdirSync(path.join(t.dataDir, 'packs-public')).length, 1, 'old bundle removed');
  } finally { t.close(); }
});

test('apply: a pack Minecraft 26.x would ignore (pack_format 69, no description) is repaired in the bundle', async () => {
  const t = await setup();
  try {
    t.app.config.update({ publicAddress: 'h.example:1' });
    const up = await t.upload('Modern.zip', await makeZip({ 'pack.mcmeta': JSON.stringify({ pack: { pack_format: 69, supported_formats: [46, 99] } }), 'assets/minecraft/x.png': 'x' }));
    assert.equal(up.status, 200, up.text);
    let r = await t.call('GET', `${S}/packs`);
    assert.ok(r.json.packs[0].problems.length >= 2, r.json.packs[0].problems.join(' | '));
    r = await t.call('POST', `${S}/packs/apply`, {});
    const job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'done', job.error); assert.equal(job.result.patched, true);
    const pubFile = path.join(t.dataDir, 'packs-public', fs.readdirSync(path.join(t.dataDir, 'packs-public'))[0]);
    const out = tmpdir(); await zip.extractZip(pubFile, out);
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'pack.mcmeta'), 'utf8'));
    assert.deepEqual(meta.pack.min_format, [97, 1]); assert.deepEqual(meta.pack.max_format, [97, 1]);
    assert.equal(meta.pack.pack_format, undefined); assert.equal(meta.pack.supported_formats, undefined);
    assert.ok(meta.pack.description);
    assert.deepEqual(packs.metaProblems(meta.pack, true), []);
    assert.ok(fs.existsSync(path.join(out, 'assets/minecraft/x.png')));
    // without a readable server version nothing is rewritten (and a forced fix is refused)
    fs.rmSync(path.join(t.sdir, 'vanilla.jar'));
    r = await t.call('POST', `${S}/packs/apply`, { patch: true });
    assert.equal(r.status, 400);
  } finally { t.close(); }
});

test('pack server: serves only published files, forwards everything else to Minecraft', async () => {
  const dir = tmpdir();
  const name = `uuid-1-${'a'.repeat(40)}.zip`;
  fs.writeFileSync(path.join(dir, name), 'ZIPDATA'.repeat(1000));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  // fake Minecraft: answers every connection with "PONG:" + what it received
  const mcSrv = net.createServer((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('PONG:'), d]))));
  await new Promise((r) => mcSrv.listen(0, '127.0.0.1', r));
  const front = createPackFront({ publicDir: dir, upstream: () => `127.0.0.1:${mcSrv.address().port}` });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${front.address().port}`;
  try {
    let res = await fetch(`${base}/p/${name}`);
    assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'ZIPDATA'.repeat(1000));
    res = await fetch(`${base}/p/${name}`, { method: 'HEAD' });
    assert.equal(res.status, 200); assert.equal(res.headers.get('content-length'), String(7000));
    for (const bad of ['/', '/p/secret.txt', '/p/../secret.txt', '/p/%2e%2e%2fsecret.txt', `/p/${'b'.repeat(40)}.zip`, '/p/uuid-1-xyz.zip', '/api/servers', '/p/']) {
      res = await fetch(base + bad); assert.equal(res.status, 404, bad); await res.arrayBuffer();
    }
    res = await fetch(`${base}/p/${name}`, { method: 'POST', body: 'x' });
    assert.equal(res.status, 405); await res.arrayBuffer();
    // a few requests on one keep-alive socket and in parallel
    const many = await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/p/${name}`).then((r) => r.arrayBuffer())));
    assert.ok(many.every((b) => b.byteLength === 7000));
    // Minecraft-like bytes (handshake packet) go to the upstream and come back
    const handshake = Buffer.from([0x10, 0x00, 0xfd, 0x05, 0x09, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x68, 0x6f, 0x73, 0x74, 0x63, 0xdd, 0x01]);
    const got = await new Promise((resolve, reject) => {
      const c = net.connect(front.address().port, '127.0.0.1', () => c.write(handshake));
      c.once('data', (d) => { c.destroy(); resolve(d); }); c.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    assert.ok(got.equals(Buffer.concat([Buffer.from('PONG:'), handshake])), 'forwarded byte for byte');
    // bytes arriving one by one still get recognised as HTTP
    const slow = await new Promise((resolve, reject) => {
      const c = net.connect(front.address().port, '127.0.0.1');
      const req = `GET /p/${name} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`;
      let i = 0; const tick = () => { if (i < 6) { c.write(req[i++]); setTimeout(tick, 5); } else c.write(req.slice(6)); }; tick();
      const chunks = []; c.on('data', (d) => chunks.push(d)); c.on('end', () => resolve(Buffer.concat(chunks).toString('latin1'))); c.on('error', reject);
    });
    assert.match(slow, /^HTTP\/1\.1 200/);
  } finally { front.close(); mcSrv.close(); front.closeAllConnections?.(); }
  // upstream down -> connection closed, no crash
  const front2 = createPackFront({ publicDir: dir, upstream: () => '127.0.0.1:1' });
  await new Promise((r) => front2.listen(0, '127.0.0.1', r));
  try {
    const closed = await new Promise((resolve) => {
      const c = net.connect(front2.address().port, '127.0.0.1', () => c.write(Buffer.from([1, 2, 3, 4, 5])));
      c.on('close', () => resolve(true)); c.on('error', () => {}); setTimeout(() => resolve(false), 3000);
    });
    assert.equal(closed, true);
  } finally { front2.close(); }
});

test('end to end: published pack is downloadable through the pack server and the check job confirms the SHA-1', async () => {
  const t = await setup();
  const dirs = packs.publicDir(t.dataDir);
  const front = createPackFront({ publicDir: dirs, upstream: () => '' });
  const socks = new Set(); front.on('connection', (s) => socks.add(s));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  try {
    t.app.config.update({ publicAddress: `127.0.0.1:${front.address().port}` });
    await t.upload('E2E.zip', await makeZip(GOOD));
    let r = await t.call('POST', `${S}/packs/check`, {});
    assert.equal(r.status, 409, 'nothing published yet');
    r = await t.call('POST', `${S}/packs/apply`, {});
    assert.equal((await t.waitJob(r.json.job.id)).status, 'done');
    r = await t.call('POST', `${S}/packs/check`, {});
    assert.equal(r.status, 202);
    const job = await t.waitJob(r.json.job.id);
    assert.equal(job.result.ok, true, JSON.stringify(job.result));
    assert.ok(job.result.bytes > 0);
    // tunnel gone -> clear failure instead of a hang
    front.close(); for (const x of socks) x.destroy();
    r = await t.call('POST', `${S}/packs/check`, {});
    const j2 = await t.waitJob(r.json.job.id);
    assert.equal(j2.result.ok, false); assert.ok(j2.result.error);
  } finally { front.close(); t.close(); }
});
