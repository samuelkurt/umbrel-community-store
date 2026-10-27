'use strict';
// Game rules page (file-based, works with the server stopped), the Nether rule and the "lock the End" data pack.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const nbt = require('../lib/nbt');
const zip = require('../lib/zip');
const gr = require('../lib/gamerules');
const noend = require('../lib/noend');
const { createApp } = require('../server');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-gr-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(30); } }
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const rulesFile = (world, rules) => {
  const data = {}; for (const [k, v] of Object.entries(rules)) data['minecraft:' + k] = typeof v === 'boolean' ? { t: 'byte', v: v ? 1 : 0 } : { t: 'int', v };
  fs.mkdirSync(path.join(world, 'data', 'minecraft'), { recursive: true });
  fs.writeFileSync(path.join(world, gr.FILE), nbt.encode('', { data: { t: 'compound', v: data }, DataVersion: { t: 'int', v: 5023 } }, { gzip: true }));
};
const levelDat = (world, spawn) => { fs.mkdirSync(world, { recursive: true }); fs.writeFileSync(path.join(world, 'level.dat'), nbt.encode('', { Data: { t: 'compound', v: { LevelName: { t: 'string', v: 'world' }, spawn: { t: 'compound', v: { pos: { t: 'list', of: 'int', v: spawn }, dimension: { t: 'string', v: 'minecraft:overworld' } } } } } }, { gzip: true })); };
async function jarWith(file, versionJson) {
  const src = tmpdir(); fs.writeFileSync(path.join(src, 'version.json'), JSON.stringify(versionJson));
  const w = new zip.ZipWriter(fs.createWriteStream(file)); await w.addTree(src, ''); await w.finish();
}
const V263 = { id: '26.3', pack_version: { resource_major: 97, resource_minor: 1, data_major: 121, data_minor: 0 } };

test('nbt: the typed reading writes back byte for byte what it read, including types and lists', () => {
  const buf = nbt.encode('', { a: { t: 'byte', v: 1 }, b: { t: 'int', v: -5 }, c: { t: 'string', v: 'x' }, l: { t: 'list', of: 'compound', v: [{ n: { t: 'int', v: 1 } }, { n: { t: 'int', v: 2 } }] }, s: { t: 'list', of: 'string', v: ['p', 'q'] }, d: { t: 'double', v: 1.5 }, k: { t: 'long', v: 7 } }, { gzip: true });
  const t = nbt.parse(buf, { typed: true });
  assert.equal(t.value.a.t, 'byte'); assert.equal(t.value.b.t, 'int'); assert.equal(t.value.l.of, 'compound');
  assert.deepEqual(nbt.parse(nbt.encode(t.name, t.value, { gzip: true }), { typed: true }), t);
  assert.deepEqual(nbt.parse(buf).value.s, ['p', 'q'], 'untyped reading is unchanged');
});

test('gamerules: types from the file, known rules get a German label, unknown ones show up under "Weitere"', () => {
  const w = tmpdir();
  assert.deepEqual(gr.read(w), { exists: false, rules: [] });
  rulesFile(w, { pvp: true, random_tick_speed: 3, brand_new_rule: false, allow_entering_nether_using_portals: true });
  const r = gr.read(w); assert.equal(r.exists, true);
  const by = Object.fromEntries(r.rules.map((x) => [x.name, x]));
  assert.deepEqual([by.pvp.type, by.pvp.value, by.pvp.category], ['bool', true, 'Kampf & Schaden']);
  assert.deepEqual([by.random_tick_speed.type, by.random_tick_speed.value], ['int', 3]);
  assert.deepEqual([by.brand_new_rule.known, by.brand_new_rule.category, by.brand_new_rule.label], [false, 'Weitere', 'brand_new_rule']);
  assert.equal(r.rules[r.rules.length - 1].name, 'brand_new_rule', 'unknown rules come last');
  assert.deepEqual([gr.eraOf('26.3'), gr.eraOf('1.21.4'), gr.eraOf('26w10a'), gr.eraOf(null)], [true, false, true, false]);
});

test('gamerules: values are checked; writing changes only that rule and keeps a backup', () => {
  assert.equal(gr.normalize('bool', 'true'), true); assert.equal(gr.normalize('int', '12'), 12); assert.equal(gr.normalize('int', -1), -1);
  for (const [t, v] of [['bool', 'vielleicht'], ['bool', 1], ['int', '1.5'], ['int', 'abc'], ['int', 2 ** 31], ['int', '1; stop']]) assert.throws(() => gr.normalize(t, v), (e) => e.status === 400, `${t} ${v}`);
  const w = tmpdir(); rulesFile(w, { pvp: true, random_tick_speed: 3, keep_inventory: false });
  const before = fs.readFileSync(path.join(w, gr.FILE));
  gr.writeRule(w, 'pvp', false); const afterFirst = fs.readFileSync(path.join(w, gr.FILE)); gr.writeRule(w, 'random_tick_speed', 9);
  const after = Object.fromEntries(gr.read(w).rules.map((x) => [x.name, x.value]));
  assert.deepEqual(after, { pvp: false, random_tick_speed: 9, keep_inventory: false });
  const raw = nbt.parse(fs.readFileSync(path.join(w, gr.FILE)), { typed: true }); assert.equal(raw.value.DataVersion.v, 5023, 'the rest of the file is kept');
  assert.equal(raw.value.data.v['minecraft:pvp'].t, 'byte', 'types stay');
  assert.ok(fs.readFileSync(path.join(w, gr.FILE + '.blockhaus.bak')).equals(afterFirst), 'backup of the previous file');
  assert.ok(!before.equals(afterFirst));
  assert.throws(() => gr.writeRule(w, 'does_not_exist', 1), (e) => e.status === 404);
  assert.throws(() => gr.writeRule(w, 'pvp', 'x'), (e) => e.status === 400);
  assert.throws(() => gr.writeRule(tmpdir(), 'pvp', true), (e) => e.status === 409);
});

test('noend: pack files for the version, nothing for versions without function/, nothing without a known spawn', () => {
  const f = noend.files({ fmt: { style: 'minor', format: 121, minor: 0 }, spawn: [-528, 69, 64] });
  assert.deepEqual(JSON.parse(f['pack.mcmeta']).pack, { description: 'Blockhaus: sperrt das End', min_format: 121, max_format: 121 });
  assert.deepEqual(JSON.parse(f['data/minecraft/tags/function/tick.json']).values, ['blockhaus_noend:tick']);
  assert.match(f['data/blockhaus_noend/function/tick.mcfunction'], /^execute as @a\[tag=!end_erlaubt\] at @s if dimension minecraft:the_end run function blockhaus_noend:zurueck\n$/);
  assert.match(f['data/blockhaus_noend/function/zurueck.mcfunction'], /^execute in minecraft:overworld run tp @s -528 69 64\ntitle @s actionbar \{"text":"Das End ist auf diesem Server gesperrt\.","color":"red"\}\n$/);
  assert.deepEqual(JSON.parse(noend.files({ fmt: { style: 'legacy', format: 48 }, spawn: [0, 64, 0] })['pack.mcmeta']).pack, { description: 'Blockhaus: sperrt das End', pack_format: 48 });
  assert.throws(() => noend.files({ fmt: { style: 'legacy', format: 26 }, spawn: [0, 64, 0] }), (e) => e.status === 409 && /1\.21/.test(e.message));
  assert.throws(() => noend.files({ fmt: null, spawn: [0, 64, 0] }), (e) => e.status === 409);
  assert.throws(() => noend.files({ fmt: { style: 'minor', format: 121 }, spawn: null }), (e) => e.status === 409 && /Spawn/.test(e.message));
});

test('noend: install and remove touch only their own folder', async () => {
  const w = tmpdir(); const jar = path.join(tmpdir(), 'server.jar'); await jarWith(jar, V263); levelDat(w, [10, 70, -3]);
  assert.deepEqual(noend.worldSpawn(w), [10, 70, -3]);
  assert.equal(noend.installed(w), false);
  await noend.install(w, { jarFile: jar });
  assert.equal(noend.installed(w), true);
  assert.match(fs.readFileSync(path.join(noend.folderOf(w), 'data', 'blockhaus_noend', 'function', 'zurueck.mcfunction'), 'utf8'), /tp @s 10 70 -3/);
  await noend.install(w, { jarFile: jar }); // again: fine
  assert.equal(await noend.remove(w), true); assert.equal(fs.existsSync(noend.folderOf(w)), false); assert.equal(await noend.remove(w), false);
  // a folder of the same name that is not ours stays untouched
  fs.mkdirSync(noend.folderOf(w), { recursive: true }); fs.writeFileSync(path.join(noend.folderOf(w), 'pack.mcmeta'), '{"pack":{"description":"fremd"}}');
  await assert.rejects(noend.install(w, { jarFile: jar }), (e) => e.status === 409);
  await assert.rejects(noend.remove(w), (e) => e.status === 409);
  assert.ok(fs.existsSync(path.join(noend.folderOf(w), 'pack.mcmeta')));
  assert.equal(await noend.dataFormat(path.join(tmpdir(), 'missing.jar')), null);
});

async function setup() {
  const tmp = tmpdir(); const serversDir = path.join(tmp, 'servers'); fs.mkdirSync(serversDir, { recursive: true });
  const bin = path.join(tmp, 'java'); fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fake-mc.js')}" "$@"\n`, { mode: 0o755 });
  const mcPort = await freePort();
  const app = createApp({ dataDir: path.join(tmp, 'data'), serversDir, mode: 'local', mcPort, settleMs: 5, localOpts: { pollMs: 60, stopTimeoutMs: 4000, ensureJava: async () => ({ bin, major: 21 }) },
    softwareInstall: async ({ dir, server, kind, version }) => { fs.writeFileSync(path.join(dir, server.executable), 'jar'); fs.writeFileSync(path.join(dir, '.blockhaus-software.json'), JSON.stringify({ software: kind, version, jar: server.executable, java: 21 })); return { software: kind, version }; } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, p, body) => { const res = await fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ } return { status: res.status, json }; };
  const mk = await call('POST', '/api/local/servers', { name: 'Welt', kind: 'vanilla', version: '26.3', memoryMb: 1024 });
  const id = mk.json.server.id; await waitFor(async () => (await call('GET', `/api/local/jobs/${mk.json.job.id}`)).json.status === 'done');
  const dir = path.join(serversDir, 'welt'); await jarWith(path.join(dir, 'server.jar'), V263);
  return { id, dir, call, api: (p) => `/api/servers/${id}/${p}`, close: async () => { await app.local.shutdown(2000).catch(() => {}); app.close(); app.closeAllConnections?.(); } };
}

test('page API, server stopped: rules read from the file, changed in the file, bad input refused, End lock written', async () => {
  const t = await setup();
  try {
    const world = path.join(t.dir, 'world');
    let r = await t.call('GET', t.api('gamerules'));
    assert.deepEqual([r.status, r.json.available, r.json.era, r.json.running, r.json.nether, r.json.end.supported, r.json.end.locked], [200, false, true, false, null, true, false]);
    rulesFile(world, { pvp: true, random_tick_speed: 3, allow_entering_nether_using_portals: true, keep_inventory: false }); levelDat(world, [5, 66, 5]);
    r = await t.call('GET', t.api('gamerules')); assert.equal(r.json.available, true); assert.equal(r.json.nether, true); assert.equal(r.json.rules.length, 4);
    assert.deepEqual((await t.call('PUT', t.api('gamerules'), { name: 'allow_entering_nether_using_portals', value: false })).json, { ok: true, name: 'allow_entering_nether_using_portals', value: false, running: false });
    assert.equal((await t.call('GET', t.api('gamerules'))).json.nether, false);
    assert.equal((await t.call('PUT', t.api('gamerules'), { name: 'random_tick_speed', value: 8 })).status, 200);
    assert.equal(gr.read(world).rules.find((x) => x.name === 'random_tick_speed').value, 8);
    for (const [body, status] of [[{ name: 'pvp', value: 'vielleicht' }, 400], [{ name: 'random_tick_speed', value: 'abc' }, 400], [{ name: 'gibts_nicht', value: 1 }, 404], [{ name: 'pvp; stop', value: true }, 400], [{ name: '../x', value: true }, 400]]) {
      const x = await t.call('PUT', t.api('gamerules'), body); assert.equal(x.status, status, JSON.stringify(body)); assert.ok(x.json.error);
    }
    // End
    r = await t.call('PUT', t.api('gamerules/end'), { locked: true });
    assert.deepEqual([r.status, r.json.locked, r.json.active, r.json.running, r.json.spawn], [200, true, null, false, [5, 66, 5]]);
    assert.equal((await t.call('GET', t.api('gamerules'))).json.end.locked, true);
    assert.ok(fs.existsSync(path.join(world, 'datapacks', 'blockhaus_noend', 'pack.mcmeta')));
    r = await t.call('PUT', t.api('gamerules/end'), { locked: false }); assert.equal(r.json.locked, false);
    assert.equal(fs.existsSync(path.join(world, 'datapacks', 'blockhaus_noend')), false);
    // not a Blockhaus pack: refused, left alone
    fs.mkdirSync(path.join(world, 'datapacks', 'blockhaus_noend'), { recursive: true }); fs.writeFileSync(path.join(world, 'datapacks', 'blockhaus_noend', 'pack.mcmeta'), '{"pack":{"description":"fremd"}}');
    assert.equal((await t.call('PUT', t.api('gamerules/end'), { locked: true })).status, 409);
    assert.equal((await t.call('PUT', t.api('gamerules/end'), { locked: false })).status, 409);
    assert.ok(fs.existsSync(path.join(world, 'datapacks', 'blockhaus_noend', 'pack.mcmeta')));
  } finally { await t.close(); }
});

test('page API, server running: rules go through the console, the End lock reloads and checks that the pack is active', async () => {
  const t = await setup();
  try {
    const world = path.join(t.dir, 'world');
    assert.equal((await t.call('POST', t.api('eula'), {})).status, 200);
    assert.equal((await t.call('POST', t.api('action/start'), {})).status, 200);
    await waitFor(async () => (await t.call('GET', t.api('status'))).json.state === 'online');
    rulesFile(world, { pvp: true, random_tick_speed: 3, allow_entering_nether_using_portals: true }); levelDat(world, [1, 64, 2]);
    const con = async () => (await t.call('GET', t.api('console'))).json.lines.join('\n');
    let r = await t.call('PUT', t.api('gamerules'), { name: 'pvp', value: false });
    assert.deepEqual([r.status, r.json.running], [200, true]);
    assert.match(await con(), /Game rule pvp is now set to false/);
    assert.equal((await t.call('PUT', t.api('gamerules'), { name: 'pvp', value: 'x' })).status, 400);
    r = await t.call('PUT', t.api('gamerules/end'), { locked: true });
    assert.deepEqual([r.status, r.json.locked, r.json.active, r.json.running], [200, true, true, true]);
    assert.ok(fs.existsSync(path.join(world, 'datapacks', 'blockhaus_noend', 'pack.mcmeta')));
    r = await t.call('PUT', t.api('gamerules/end'), { locked: false });
    assert.deepEqual([r.status, r.json.locked], [200, false]);
    assert.equal(fs.existsSync(path.join(world, 'datapacks', 'blockhaus_noend')), false);
    assert.match(await con(), /Disabling data pack \[file\/blockhaus_noend/);
    await t.call('POST', t.api('action/stop'), {});
  } finally { await t.close(); }
});
