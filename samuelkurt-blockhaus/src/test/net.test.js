'use strict';
// Tests against the REAL download APIs (Mojang, PaperMC, Purpur, Fabric, Quilt, NeoForge, Forge, Modrinth).
// Skipped unless NET=1, because they need internet and download a few hundred MB.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sw = require('../lib/software');
const mods = require('../lib/mods');

const NET = process.env.NET === '1';
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-net-'));
const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const fakeServer = { execution_command: 'java -Xmx1G -jar vanilla.jar nogui', executable: 'vanilla.jar' };

test('net: every supported kind lists versions, 1.21.4 is available where expected', { skip: !NET, timeout: 120000 }, async () => {
  for (const k of sw.KINDS.filter((x) => !x.unsupported)) {
    const v = await sw.listVersions(k.id);
    assert.ok(v.length > 3, `${k.id}: ${v.length} versions`);
    assert.ok(v.every((x) => x.id && typeof x.stable === 'boolean'), k.id);
    if (['vanilla', 'paper', 'purpur', 'fabric', 'quilt', 'neoforge', 'forge'].includes(k.id)) assert.ok(v.some((x) => x.id === '1.21.4'), `${k.id} has 1.21.4`);
  }
  const snaps = await sw.listVersions('snapshot');
  assert.ok(snaps.every((s) => !s.stable));
});

test('net: resolve gives a URL plus a checksum wherever the upstream provides one', { skip: !NET, timeout: 120000 }, async () => {
  const want = { vanilla: 'sha1', paper: 'sha256', purpur: 'md5', quilt: 'sha1', neoforge: 'sha1', forge: 'sha1' };
  for (const kind of ['vanilla', 'paper', 'purpur', 'fabric', 'quilt', 'neoforge', 'forge']) {
    const r = await sw.resolve(kind, '1.21.4');
    assert.match(r.url, /^https:\/\//, kind);
    assert.equal(r.java, 21, kind + ' java');
    if (want[kind]) assert.match(r.checksum[want[kind]] || '', /^[0-9a-f]{32,64}$/, kind + ' checksum');
    assert.equal(r.type, ['quilt', 'neoforge', 'forge'].includes(kind) ? 'installer' : 'jar', kind);
  }
  const latest = (await sw.listVersions('vanilla'))[0].id;
  const r = await sw.resolve('vanilla', latest);
  assert.ok(r.java >= 21, `latest ${latest} needs Java ${r.java}`);
});

test('net: install vanilla, then Paper over it, then Forge (launcher) — jar swapped, state recorded', { skip: !NET, timeout: 300000 }, async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'vanilla.jar'), 'old');
  let st = await sw.install({ dir, server: fakeServer, kind: 'vanilla', version: '1.21.4', job: {} });
  assert.equal(sha1(path.join(dir, 'vanilla.jar')), '4707d00eb834b446575d89a61a11b5d548d8c001', 'official Mojang 1.21.4 server.jar');
  assert.equal(fs.readFileSync(path.join(dir, 'vanilla.jar.blockhaus-prev'), 'utf8'), 'old');
  assert.equal(st.software, 'vanilla');
  st = await sw.install({ dir, server: fakeServer, kind: 'paper', version: '1.21.4', job: {} });
  assert.equal(sw.readInstalled(dir).software, 'paper');
  assert.ok(fs.statSync(path.join(dir, 'vanilla.jar')).size > 40e6);
  assert.equal(fs.existsSync(path.join(dir, 'blockhaus-launch.properties')), false);
  st = await sw.install({ dir, server: fakeServer, kind: 'forge', version: '1.21.4', job: {} });
  assert.equal(st.firstStartInstalls, true);
  assert.ok(fs.readFileSync(path.join(dir, 'vanilla.jar')).equals(fs.readFileSync(sw.LAUNCHER_JAR)), 'launcher replaces the jar');
  const props = fs.readFileSync(path.join(dir, 'blockhaus-launch.properties'), 'utf8');
  assert.match(props, /installer\.args=--installServer/);
  assert.match(props, /launch\.1=args:libraries\/net\/minecraftforge\/forge\/1\.21\.4-/);
  assert.ok(fs.statSync(path.join(dir, 'blockhaus/installer.jar')).size > 1e6);
  // and back to Fabric: launcher properties must go away, otherwise a plain jar would never be used
  await sw.install({ dir, server: fakeServer, kind: 'fabric', version: '1.21.4', job: {} });
  assert.equal(fs.existsSync(path.join(dir, 'blockhaus-launch.properties')), false);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.blockhaus-dl')), [], 'no download leftovers');
});

test('net: a corrupted download is rejected and the old jar is kept', { skip: !NET, timeout: 120000 }, async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'vanilla.jar'), 'old');
  const real = sw.resolve;
  // ask for a version, but let the checksum lie
  const dl = require('../lib/download');
  const r = await real('vanilla', '1.21.4');
  await assert.rejects(dl.downloadFile(r.url, path.join(dir, 'x.jar'), { sha1: '0'.repeat(40) }), /Prüfsumme/);
  assert.equal(fs.existsSync(path.join(dir, 'x.jar')), false);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.part')), []);
  assert.equal(fs.readFileSync(path.join(dir, 'vanilla.jar'), 'utf8'), 'old');
});

test('net: Modrinth search + install with required dependency and hash check', { skip: !NET, timeout: 180000 }, async () => {
  const dir = tmpdir();
  const lay = mods.layout(dir, { software: 'fabric', version: '1.21.4' });
  const s = await mods.search(lay, '1.21.4', { query: 'sodium extra' });
  assert.ok(s.hits.some((h) => h.title === 'Sodium Extra'));
  const written = await mods.installFromModrinth({ dir, lay, mcVersion: '1.21.4', project: 'PtjYWJkn', job: {} });
  assert.ok(written.length >= 2, 'Sodium Extra pulls in Sodium: ' + written.join(', '));
  const listed = await mods.list(dir, { software: 'fabric', version: '1.21.4' });
  assert.ok(listed.items.some((i) => i.id === 'sodium'), 'sodium installed as dependency');
  assert.ok(listed.items.every((i) => i.loader === 'fabric' && i.version), 'metadata read from the real jars');
  assert.ok(listed.items.every((i) => i.modrinth), 'origin recorded');
  assert.deepEqual(await mods.installFromModrinth({ dir, lay, mcVersion: '1.21.4', project: 'PtjYWJkn', job: {} }), [], 'second install is a no-op');
  // plugin side
  const pl = mods.layout(dir, { software: 'paper', version: '1.21.4' });
  const ps = await mods.search(pl, '1.21.4', { query: 'luckperms' });
  assert.ok(ps.hits.length > 0);
  // no compatible build -> clear error
  await assert.rejects(mods.installFromModrinth({ dir: tmpdir(), lay, mcVersion: '1.7.10', project: 'AANobbMI', job: {} }), /keine Version/);
});
